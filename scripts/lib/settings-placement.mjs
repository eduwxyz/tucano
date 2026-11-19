import { parse } from '@babel/parser';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

const children = node => Object.entries(node).filter(([key]) => !['loc', 'extra', 'comments', 'leadingComments', 'trailingComments', 'typeAnnotation', 'returnType', 'typeParameters'].includes(key)).flatMap(([, value]) =>
  Array.isArray(value) ? value.filter(n => n && typeof n.type === 'string') : value && typeof value.type === 'string' ? [value] : []);
const find = (node, predicate) => predicate(node) ? node : children(node).map(n => find(n, predicate)).find(Boolean);
const property = (node, name) => node.properties?.find(p => p.type === 'ObjectProperty' && (p.key.name || p.key.value) === name)?.value;

// This checks declared ownership against literal Settings writes in the rendered component
// graph. RPC-only controls and dynamic patches still need the documented product review.
export function inspectSettingsPlacement(workspace) {
  const root = resolve(workspace);
  const files = new Map();
  const read = file => {
    if (files.has(file)) return files.get(file);
    const source = readFileSync(file, 'utf8');
    const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] });
    const functions = new Map(ast.program.body.map(n => n.declaration || n).filter(n => n.type === 'FunctionDeclaration').map(n => [n.id.name, n]));
    for (const declaration of ast.program.body.map(n => n.declaration || n).filter(n => n.type === 'VariableDeclaration')) {
      for (const variable of declaration.declarations) if (variable.id.type === 'Identifier' && ['ArrowFunctionExpression', 'FunctionExpression'].includes(variable.init?.type)) functions.set(variable.id.name, variable.init);
    }
    const imports = new Map();
    for (const declaration of ast.program.body.filter(n => n.type === 'ImportDeclaration' && n.source.value.startsWith('.'))) {
      const path = resolve(dirname(file), declaration.source.value);
      const target = [path + '.tsx', path + '.ts', join(path, 'index.tsx'), join(path, 'index.ts')].find(existsSync);
      if (!target) continue;
      if (!target.startsWith(join(root, 'src') + sep)) throw new Error('Review settings imports outside src: ' + target);
      for (const specifier of declaration.specifiers.filter(n => n.type === 'ImportSpecifier' && n.importKind !== 'type')) imports.set(specifier.local.name, { file: target, name: specifier.imported.name });
    }
    const result = { source, ast, functions, imports };
    files.set(file, result);
    return result;
  };
  const structureFile = join(root, 'src/renderer/src/settings-structure.ts');
  const structure = read(structureFile).functions.get('settingsStructure');
  if (!structure) throw new Error('Missing settingsStructure.');
  const declared = find(structure, n => n.type === 'ArrayExpression' && n.elements.length && n.elements.every(el => el?.type === 'ObjectExpression' && property(el, 'id')));
  const sections = declared.elements.map(node => ({ id: property(node, 'id').value, keys: property(node, 'keys').elements.map(key => key.value) }));
  const failures = [];
  const owners = new Map();
  const sectionIds = new Set();
  for (const section of sections) {
    if (sectionIds.has(section.id)) failures.push(`Duplicate section: ${section.id}`);
    sectionIds.add(section.id);
    for (const key of section.keys) {
      if (owners.has(key)) failures.push(`${key} is owned by both ${owners.get(key)} and ${section.id}`);
      owners.set(key, section.id);
    }
  }
  const pagesFile = join(root, 'src/renderer/src/components/Pages.tsx');
  const page = read(pagesFile).functions.get('SettingsPage');
  const slot = find(page, n => n.type === 'VariableDeclarator' && n.id.name === 'content');
  if (slot?.init?.type !== 'ObjectExpression') throw new Error('SettingsPage must render its declared content map.');
  const rendered = new Set();
  const visited = new Set();
  const writes = [];
  const parts = { 'knowledge-wiki-capture': 'curator', 'knowledge-wiki-resolver': 'resolver', 'knowledge-wiki-storage': 'storage', 'knowledge-wiki-import': 'import', 'knowledge-wiki-rules': 'rules' };
  const truth = (node, section) => {
    const part = parts[section];
    if (!part) return undefined;
    if (node.type === 'Identifier' && node.name === 'part') return true;
    if (node.type === 'UnaryExpression' && node.operator === '!') { const value = truth(node.argument, section); return value === undefined ? undefined : !value; }
    if (node.type === 'BinaryExpression' && node.operator === '===' && node.left.name === 'part' && node.right.type === 'StringLiteral') return part === node.right.value;
    if (node.type === 'LogicalExpression') {
      const left = truth(node.left, section), right = truth(node.right, section);
      if (node.operator === '||') return left === true || right === true ? true : left === false && right === false ? false : undefined;
      if (node.operator === '&&') return left === false || right === false ? false : left === true && right === true ? true : undefined;
    }
    return undefined;
  };
  const scanFunction = (file, name, section, aliases) => {
    const signature = `${file}:${name}:${section}:${aliases.join(',')}`;
    if (visited.has(signature)) return;
    visited.add(signature);
    const resource = read(file);
    const definition = resource.functions.get(name);
    if (definition) scan(definition.body, file, section, aliases);
  };
  const scan = (node, file, section, aliases = ['updateSettings']) => {
    if (node === slot) return;
    if (node.type === 'LogicalExpression' && node.operator === '&&' && truth(node.left, section) === false) return;
    if (node.type === 'CallExpression' && aliases.includes(node.callee.name) && node.arguments[0]?.type === 'ObjectExpression') {
      for (const item of node.arguments[0].properties) {
        if (item.type !== 'ObjectProperty') continue;
        const key = item.computed ? undefined : item.key.name || item.key.value;
        if (!key) { failures.push(`Computed settings write needs explicit review at ${file}:${node.loc.start.line}`); continue; }
        writes.push({ key, section, file, line: node.loc.start.line });
        if (!section || owners.get(key) !== section) failures.push(`${key} is written in ${section || 'unplaced UI'}; declared home: ${owners.get(key) || 'missing'} (${file}:${node.loc.start.line})`);
      }
    }
    if (node.type === 'JSXElement' || node.type === 'JSXSelfClosingElement') {
      const opening = node.openingElement || node;
      const name = opening.name.name;
      if (name && /^[A-Z]/.test(name)) {
        const resource = read(file);
        const target = resource.functions.has(name) ? { file, name } : resource.imports.get(name);
        const passed = opening.attributes.filter(attr => attr.type === 'JSXAttribute' && attr.value?.type === 'JSXExpressionContainer' && aliases.includes(attr.value.expression.name)).map(attr => attr.name.name);
        if (target) scanFunction(target.file, target.name, section, [...new Set(['updateSettings', ...passed])]);
      }
    }
    children(node).forEach(child => scan(child, file, section, aliases));
  };
  for (const entry of slot.init.properties) {
    const id = entry.key.value || entry.key.name;
    if (rendered.has(id)) failures.push(`Duplicate rendering slot: ${id}`);
    rendered.add(id);
    if (!sectionIds.has(id)) failures.push(`Undeclared rendering slot: ${id}`);
    scan(entry.value, pagesFile, id);
  }
  for (const id of sectionIds) if (!rendered.has(id)) failures.push(`Section has no rendering slot: ${id}`);
  scan(page.body, pagesFile, undefined);
  return { sections: sections.length, ownedKeys: owners.size, checkedWrites: writes.length, files: files.size, writes, failures: [...new Set(failures)], passed: failures.length === 0 };
}
