import { describe, expect, it } from 'vitest';
import { renderTemplate, templateVars } from '../src/core/template.js';

describe('templates', () => {
  it('lists and renders variables', () => {
    const text = 'Hi {{username}}, sent to {{ email }}';
    expect(templateVars(text)).toEqual(['username', 'email']);
    expect(renderTemplate(text, { username: 'ana', email: 'a@b.co' })).toBe('Hi ana, sent to a@b.co');
  });

  it('throws on a missing variable', () => {
    expect(() => renderTemplate('{{nope}}', {})).toThrow(/nope/);
  });

  it('does not re-expand placeholders inside values', () => {
    expect(renderTemplate('{{a}}', { a: '{{b}}', b: 'x' })).toBe('{{b}}');
  });
});
