const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function templateVars(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => m[1]!);
}

export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_, name: string) => {
    const value = vars[name];
    if (value === undefined) throw new Error(`template variable not set: ${name}`);
    return value;
  });
}
