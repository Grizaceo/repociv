import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

describe('native picker POST requests', () => {
  it.each([
    ['src/map.ts', '/api/map-roots/pick'],
    ['src/ui/constructionPanel.ts', '/api/repo/pick'],
    ['src/ui/onboardingPanel.ts', '/api/map-root/pick'],
  ])('%s sends JSON to %s', (file, url) => {
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
    );
    let options: ts.ObjectLiteralExpression | undefined;
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === 'fetch' &&
        ts.isStringLiteral(node.arguments[0]!) &&
        node.arguments[0].text === url &&
        node.arguments[1] &&
        ts.isObjectLiteralExpression(node.arguments[1])
      ) {
        options = node.arguments[1];
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    expect(options, `fetch options for ${url}`).toBeDefined();
    const property = (object: ts.ObjectLiteralExpression, name: string) =>
      object.properties.find(
        (p): p is ts.PropertyAssignment =>
          ts.isPropertyAssignment(p) && p.name.getText(source).replace(/['"]/g, '') === name,
      )?.initializer;
    const headers = property(options!, 'headers');
    expect(headers && ts.isObjectLiteralExpression(headers), 'JSON headers').toBe(true);
    if (!headers || !ts.isObjectLiteralExpression(headers)) return;
    expect(property(headers, 'Content-Type')?.getText(source)).toMatch(
      /^['"]application\/json['"]$/,
    );
    expect(property(options!, 'body')?.getText(source)).toMatch(/^['"]\{\}['"]$/);
  });
});
