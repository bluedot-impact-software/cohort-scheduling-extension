import GLPK, { Options } from "glpk.js";

export interface SchedulerInput {
  lengthOfMeeting: number,
  personTypes: PersonType[],
}

export interface PersonType {
  name: string,
  min: number,
  max: number,
  people: Person[],
}

export interface Person {
  id: string,
  name: string,
  timeAv: [number, number][],
  howManyCohorts: number,
}

export interface Cohort {
  time: number,
  /** Map from person type name -> person id */
  people: { [personType: string]: string[] },
}

const toBinary = (personType: PersonType, person: Person, t: number) => `${personType.name}-${person.id}-${t}`;
const fromBinary = (binary: string): [string, string, string] => binary.split("-") as [string, string, string];

const getCohortCount = (t) => `cohortCount-${t}`;

// See https://www.notion.so/bluedot-impact/Cohort-scheduling-algorithm-5aea0c98fcbe4ddfac3321cd1afd56c3#e9efb553c9b3499e9669f08cda7dd322
export async function solve({ lengthOfMeeting, personTypes }: SchedulerInput): Promise<Cohort[]> {
  const glpk = await GLPK();

  const options: Options = {
    msglev: glpk.GLP_MSG_ALL,
    presol: true,
    cb: {
      call: (progress) => {
        console.log("progress", progress);
      },
      each: 1,
    },
  };

  let maxT = 0;
  for (const personType of personTypes)
    for (const person of personType.people)
      for (const timeAv of person.timeAv)
        for (const t of timeAv) if (t > maxT) maxT = t;

  // array from 0 to maxT
  const times = Array.from({ length: maxT }, (_, i) => i);

  // VARIABLES
  const binaries = [];
  for (const personType of personTypes) {
    for (const person of personType.people) {
      for (const t of times) {
        binaries.push(toBinary(personType, person, t));
      }
    }
  }

  const cohortCounts = [];
  for (const t of times) {
    cohortCounts.push(getCohortCount(t));
  }

  const assignmentConstraints = [];
  const availabilityConstraints = [];
  const nonOverlappingConstraints = [];
  for (const personType of personTypes) {
    for (const person of personType.people) {
      const personBinaries = [];
      for (const t of times) {
        const u = toBinary(personType, person, t);
        personBinaries.push(u);

        availabilityConstraints.push({
          vars: [{ name: u, coef: 1 }],
          bnds: {
            type: glpk.GLP_UP,
            ub: person.timeAv.some(
              ([b, e]) => b <= t && t <= e - lengthOfMeeting
            )
              ? 1
              : 0,
          },
        });

        const meetingVars = [];
        for (let i = 0; i < lengthOfMeeting; i++) {
          meetingVars.push(toBinary(personType, person, t + i));
        }
        nonOverlappingConstraints.push({
          vars: meetingVars.map((u) => ({ name: u, coef: 1 })),
          bnds: {
            type: glpk.GLP_UP,
            ub: 1,
          },
        });
      }

      assignmentConstraints.push({
        vars: personBinaries.map((u) => ({ name: u, coef: 1 })),
        bnds: { type: glpk.GLP_UP, ub: person.howManyCohorts },
      });
    }
  }

  const cohortCountConstraints = [];
  for (const t of times) {
    for (const personType of personTypes) {
      const personBinaries = [];
      for (const person of personType.people) {
        personBinaries.push(toBinary(personType, person, t));
      }
      cohortCountConstraints.push({
        vars: [
          ...personBinaries.map((u) => ({ name: u, coef: 1 })),
          { name: getCohortCount(t), coef: -personType.max },
        ],
        bnds: { type: glpk.GLP_UP, ub: 0 },
      });
      cohortCountConstraints.push({
        vars: [
          ...personBinaries.map((u) => ({ name: u, coef: 1 })),
          { name: getCohortCount(t), coef: -personType.min },
        ],
        bnds: { type: glpk.GLP_LO, lb: 0 },
      });
    }
  }

  const constraints = [
    ...assignmentConstraints,
    ...availabilityConstraints,
    ...nonOverlappingConstraints,
    ...cohortCountConstraints,
  ];

  try {
    const res = await glpk.solve(
      {
        name: "eh?",
        objective: {
          direction: glpk.GLP_MAX,
          name: "eh2?",
          vars: binaries.map((u) => ({ name: u, coef: 1 })),
        },
        subjectTo: constraints,
        generals: cohortCounts,
        binaries: binaries,
      },
      options
    );

    /* PROCESS RESULT
     [{ people: { Participant: [id, ...], Facilitator: [id, ...] }
        time: number }, ...] */
    const timeslots = {};
    for (const binary of Object.keys(res.result.vars)) {
      if (binary.includes("cohortCount")) continue;
      const [personType, person, t] = fromBinary(binary);
      if (res.result.vars[binary] == 1) {
        if (!timeslots[t]) timeslots[t] = {};
        if (!timeslots[t][personType]) timeslots[t][personType] = [];
        timeslots[t][personType].push(person);
      }
    }

    const largeCohorts: Cohort[] = [];
    for (const t of Object.keys(timeslots)) {
      largeCohorts.push({
        time: parseInt(t),
        people: timeslots[t],
      });
    }

    const cohorts: Cohort[] = [];
    for (const largeCohort of largeCohorts) {
      const count = res.result.vars[getCohortCount(largeCohort.time)];
      const cohortCounts = {};
      for (const personType of personTypes) {
        const people = largeCohort.people[personType.name];
        const n = people.length;

        // divide n by count with remainder
        const r = n % count;
        const k = Math.floor(n / count);

        if (!cohortCounts[personType.name]) cohortCounts[personType.name] = [];
        for (let i = 0; i < count - r; i++) {
          cohortCounts[personType.name].push(k);
        }
        for (let i = 0; i < r; i++) {
          cohortCounts[personType.name].push(k + 1);
        }
      }
      for (let i = 0; i < count; i++) {
        const people = {};
        for (const personType of personTypes) {
          people[personType.name] = largeCohort.people[personType.name].slice(
            i * cohortCounts[personType.name][i],
            (i + 1) * cohortCounts[personType.name][i]
          );
        }

        cohorts.push({
          time: largeCohort.time,
          people,
        });
      }
    }

    return cohorts;
  } catch (e) {
    console.log(e);
  }
}
