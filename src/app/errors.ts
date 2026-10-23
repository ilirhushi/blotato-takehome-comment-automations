export class PermanentStepError extends Error {}

/** Another worker took over this run after our lease expired. */
export class LeaseLostError extends Error {}
