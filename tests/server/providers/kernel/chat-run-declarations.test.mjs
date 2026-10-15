import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_RUN_DECLARATION_LIMIT, CHAT_RUN_DECLARATION_MS, createChatRunDeclarations,
} from "../../../../server/providers/kernel/chat-run-declarations.mjs";

const id = (digit) => `${String(digit).repeat(8)}-0000-4000-8000-000000000000`;

test("a declaration holds only a version 4 UUID, and refuses anything else", () => {
  const declarations = createChatRunDeclarations();
  for (const value of ["", "not-a-uuid", "0B7C2A4E-1F3D-4C5B-9A8E-7D6F5E4C3B2A", "0b7c2a4e-1f3d-1c5b-9a8e-7d6f5e4c3b2a", `${id(1)} `, "../x", "C:\\private", 7, null, undefined, { id: id(1) }]) {
    assert.equal(declarations.declare(value), false, JSON.stringify(value));
    assert.equal(declarations.withdraw(value), false, JSON.stringify(value));
  }
  assert.equal(declarations.declare(id(1)), true);
  assert.equal(declarations.has(id(1)), true);
  assert.equal(declarations.has(id(2)), false);
});

test("a declaration lasts one turn and a minute, then expires on its own; a withdrawal ends it at once", () => {
  let clock = 1_000;
  const declarations = createChatRunDeclarations({ now: () => clock });
  assert.equal(CHAT_RUN_DECLARATION_MS, 11 * 60_000);
  declarations.declare(id(1));
  declarations.declare(id(2));
  clock += CHAT_RUN_DECLARATION_MS - 1;
  assert.equal(declarations.has(id(1)), true);
  clock += 1;
  assert.equal(declarations.has(id(1)), false);
  declarations.declare(id(3));
  assert.equal(declarations.withdraw(id(3)), true);
  assert.equal(declarations.has(id(3)), false);
});

test("the set is bounded: the oldest declaration gives way", () => {
  const declarations = createChatRunDeclarations();
  for (let digit = 1; digit <= CHAT_RUN_DECLARATION_LIMIT + 1; digit += 1) declarations.declare(id(digit));
  assert.equal(declarations.has(id(1)), false);
  for (let digit = 2; digit <= CHAT_RUN_DECLARATION_LIMIT + 1; digit += 1) assert.equal(declarations.has(id(digit)), true);
});
