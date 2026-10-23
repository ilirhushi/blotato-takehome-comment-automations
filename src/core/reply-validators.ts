export type ReplyValidator = 'email';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** Returns the extracted value, or null if the reply is not valid. */
export function validateReply(validator: ReplyValidator, text: string): string | null {
  switch (validator) {
    case 'email':
      return text.match(EMAIL)?.[0] ?? null;
  }
}
