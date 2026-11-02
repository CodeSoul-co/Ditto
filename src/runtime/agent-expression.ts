import type { JsonValue } from "../contracts/common.js";
import { isDeepStrictEqual } from "node:util";
import { AgentValidationError, pointer } from "./agent-diagnostics.js";

export type Expression = (scope: Readonly<Record<string, unknown>>) => unknown;
const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function fail(where: string, message: string, code?: string): never { throw new AgentValidationError(where, message, code); }
export function record(value: unknown, where: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(where, "expected an object");
  return value as Record<string, unknown>;
}
export function fields(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(pointer(where, key), `unknown field ${key}`, "UNKNOWN_FIELD");
}
export function name(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) || forbidden.has(value))
    fail(where, "expected an identifier (letters, digits, underscore or hyphen)");
  return value;
}
export function positive(value: unknown, where: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) fail(where, "expected a positive integer");
  return value as number;
}

/** Snapshot JSON before compiling: reject executable values, cycles and prototype keys. */
export function snapshot(value: unknown): JsonValue {
  let count = 0;
  const ancestors = new Set<object>();
  function visit(v: unknown, depth: number, path: string): JsonValue {
    if (++count > 100_000 || depth > 64) fail(path, "JSON size/depth limit exceeded", "LIMIT_EXCEEDED");
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (!v || typeof v !== "object" || ancestors.has(v)) fail(path, "expected acyclic JSON");
    if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null)
      fail(path, "expected plain JSON objects");
    ancestors.add(v);
    const result = Array.isArray(v) ? v.map((item, i) => visit(item, depth + 1, pointer(path, i)))
      : Object.fromEntries(Object.entries(v).map(([key, item]) => {
        if (forbidden.has(key)) fail(pointer(path, key), `forbidden key ${key}`);
        return [key, visit(item, depth + 1, pointer(path, key))];
      }));
    ancestors.delete(v);
    return Object.freeze(result);
  }
  return visit(value, 0, "");
}

export function pathParts(value: unknown, where: string): string[] {
  if (typeof value !== "string" || !value.length) fail(where, "expected a reference path");
  const parts = value.split(".");
  if (parts.some(p => !/^[A-Za-z0-9_-]+$/.test(p) || forbidden.has(p))) fail(where, "invalid reference path");
  return parts;
}
export function lookup(value: unknown, parts: readonly string[]): unknown {
  for (const part of parts) {
    if (!value || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}
export function boolean(value: unknown, where: string): boolean {
  if (typeof value !== "boolean") fail(where, "condition must return a boolean");
  return value;
}
function array(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) fail(where, "expected an array");
  return value;
}
function number(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(where, "expected a finite number");
  return value;
}

/** Expressions are compiled once, never evaluated as JavaScript. */
export function expression(value: unknown, roots: readonly string[], where: string, dependencies?: readonly string[], references?: Set<string>): Expression {
  if (value === null || typeof value !== "object") return () => value;
  if (Array.isArray(value)) {
    const items = value.map((v, i) => expression(v, roots, pointer(where, i), dependencies, references));
    return scope => items.map(fn => fn(scope));
  }
  const object = record(value, where);
  if (Object.hasOwn(object, "$literal")) {
    fields(object, ["$literal"], where);
    return () => structuredClone(object.$literal);
  }
  if (Object.hasOwn(object, "$ref")) {
    fields(object, ["$ref", "default"], where);
    const parts = pathParts(object.$ref, pointer(where, "$ref"));
    references?.add(parts.slice(0, parts[0] === "nodes" ? 2 : 1).join("."));
    if (!roots.includes(parts[0]!)) fail(pointer(where, "$ref"), `unknown reference root ${parts[0]}`, "INVALID_REFERENCE");
    if (parts[0] === "nodes" && dependencies && (!parts[1] || !dependencies.includes(parts[1])))
      fail(pointer(where, "$ref"), "node references must name a declared dependency", "INVALID_REFERENCE");
    const fallback = Object.hasOwn(object, "default") ? expression(object.default, roots, pointer(where, "default"), dependencies, references) : undefined;
    return scope => {
      const found = lookup(scope, parts);
      if (found !== undefined) return structuredClone(found);
      if (fallback) return fallback(scope);
      return fail(where, `missing reference ${String(object.$ref)}`);
    };
  }
  if (Object.hasOwn(object, "$map")) {
    fields(object, ["$map"], where);
    const mapping = record(object.$map, pointer(where, "$map"));
    fields(mapping, ["items", "value"], pointer(where, "$map"));
    if (!Object.hasOwn(mapping, "items") || !Object.hasOwn(mapping, "value")) fail(where, "$map requires items and value");
    const items = expression(mapping.items, roots, `${where}/$map/items`, dependencies, references);
    const project = expression(mapping.value, [...roots, "item", "index"], `${where}/$map/value`, dependencies, references);
    return scope => array(items(scope), where).map((item, index) => project(Object.assign(
      Object.defineProperties({}, Object.getOwnPropertyDescriptors(scope)), { item, index },
    )));
  }
  if (Object.hasOwn(object, "$op")) {
    fields(object, ["$op", "args"], where);
    const arities: Record<string, number> = {
      eq: 2, ne: 2, lt: 2, lte: 2, gt: 2, gte: 2, add: 2, subtract: 2,
      and: 2, or: 2, not: 1, length: 1, at: 2, append: 2, concat: 2,
      merge: 2, first: 1, dropFirst: 1, isEmpty: 1,
    };
    const op = String(object.$op);
    if (!Object.hasOwn(arities, op) || !Array.isArray(object.args) || object.args.length !== arities[op])
      fail(where, "unknown operator or invalid argument count", "INVALID_EXPRESSION");
    const args = object.args.map((v, i) => expression(v, roots, `${where}/args/${i}`, dependencies, references));
    return scope => {
      const a = args[0]!(scope);
      if (op === "and") return boolean(a, where) && boolean(args[1]!(scope), where);
      if (op === "or") return boolean(a, where) || boolean(args[1]!(scope), where);
      const b = args[1]?.(scope);
      switch (op) {
        case "eq": return isDeepStrictEqual(a, b);
        case "ne": return !isDeepStrictEqual(a, b);
        case "lt": return number(a, where) < number(b, where);
        case "lte": return number(a, where) <= number(b, where);
        case "gt": return number(a, where) > number(b, where);
        case "gte": return number(a, where) >= number(b, where);
        case "add": return number(number(a, where) + number(b, where), where);
        case "subtract": return number(number(a, where) - number(b, where), where);
        case "not": return !boolean(a, where);
        case "length": return typeof a === "string" ? a.length : array(a, where).length;
        case "isEmpty": return array(a, where).length === 0;
        case "first": if (!array(a, where).length) fail(where, "empty array"); return array(a, where)[0];
        case "dropFirst": return array(a, where).slice(1);
        case "at": {
          const items = array(a, where), i = number(b, where);
          if (!Number.isSafeInteger(i) || i < 0 || i >= items.length) fail(where, "array index out of bounds");
          return items[i];
        }
        case "append": return [...array(a, where), b];
        case "concat": return [...array(a, where), ...array(b, where)];
        case "merge": return { ...record(a, where), ...record(b, where) };
        default: return fail(where, "unknown operator");
      }
    };
  }
  const entries = Object.entries(object).map(([key, v]) => {
    if (key.startsWith("$")) fail(where, `unknown expression ${key}; use $literal for literal data`);
    return [key, expression(v, roots, pointer(where, key), dependencies, references)] as const;
  });
  return scope => Object.fromEntries(entries.map(([key, fn]) => [key, fn(scope)]));
}
