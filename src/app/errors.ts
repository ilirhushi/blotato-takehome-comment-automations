import { TransientPlatformError } from '../platform/types.js';

export class PermanentStepError extends Error {}

/** The platform call took too long. It may still have been delivered. */
export class SendTimeoutError extends TransientPlatformError {}

/** Another worker took over this run after our lease expired. */
export class LeaseLostError extends Error {}
