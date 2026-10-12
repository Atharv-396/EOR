// =============================================================================
// MIGRATION 108 — Make organization_id nullable in OAuth token tables
//
// Why: super_admin users have no real organization (org_id = 0 in the JWT is
// a sentinel, not a real row). Migration 003 created oauth_access_tokens,
// oauth_refresh_tokens, and oauth_authorization_codes with
//   organization_id BIGINT UNSIGNED NOT NULL REFERENCES organizations(id)
// which means inserting a token for a super_admin always violates the FK
// (no organizations row with id = 0). Storing NULL for super_admin tokens
// is semantically correct and consistent with how auth.service.ts already
// handles the missing org (org?.id ?? 0).
//
// Safe to run on existing data: the only super_admin tokens that exist are
// ones that succeeded (they can't exist yet given the bug), so no existing
// rows need to be back-filled. Regular org tokens keep their organization_id
// value unchanged.
//
// Idempotent: the information_schema guard skips each ALTER if the column is
// already nullable.
// =============================================================================

import { Knex } from "knex";

const TABLES = [
  "oauth_access_tokens",
  "oauth_refresh_tokens",
  "oauth_authorization_codes",
] as const;

async function isNullable(knex: Knex, table: string): Promise<boolean> {
  const [rows] = (await knex.raw(
    `SELECT IS_NULLABLE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME   = ?
       AND COLUMN_NAME  = 'organization_id'`,
    [table],
  )) as [Array<{ IS_NULLABLE: string }>, unknown];
  // IS_NULLABLE is 'YES' or 'NO'
  return rows[0]?.IS_NULLABLE === "YES";
}

async function dropFkIfExists(knex: Knex, table: string, fkName: string): Promise<void> {
  const [rows] = (await knex.raw(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA     = DATABASE()
       AND TABLE_NAME       = ?
       AND CONSTRAINT_NAME  = ?
       AND CONSTRAINT_TYPE  = 'FOREIGN KEY'`,
    [table, fkName],
  )) as [Array<{ CONSTRAINT_NAME: string }>, unknown];
  if (rows.length > 0) {
    await knex.raw(`ALTER TABLE ?? DROP FOREIGN KEY ??`, [table, fkName]);
  }
}

async function fkExists(knex: Knex, table: string, fkName: string): Promise<boolean> {
  const [rows] = (await knex.raw(
    `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS
     WHERE TABLE_SCHEMA     = DATABASE()
       AND TABLE_NAME       = ?
       AND CONSTRAINT_NAME  = ?
       AND CONSTRAINT_TYPE  = 'FOREIGN KEY'`,
    [table, fkName],
  )) as [Array<{ CONSTRAINT_NAME: string }>, unknown];
  return rows.length > 0;
}

export async function up(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;
    if (await isNullable(knex, table)) continue; // already nullable — idempotent

    // Step 1: drop the existing NOT NULL FK constraint.
    // The FK name produced by Knex/MySQL for these tables is predictable:
    //   <table>_organization_id_foreign
    const fkName = `${table}_organization_id_foreign`;
    await dropFkIfExists(knex, table, fkName);

    // Step 2: ALTER the column to allow NULL.
    // We keep UNSIGNED BIGINT to match the rest of the schema; we just drop
    // the NOT NULL constraint.
    await knex.raw(
      `ALTER TABLE ?? MODIFY COLUMN organization_id BIGINT UNSIGNED NULL`,
      [table],
    );

    // Step 3: re-add the FK as nullable (ON DELETE SET NULL so that if the
    // organization is deleted the token becomes org-less rather than cascading
    // away the super_admin's active session).
    const newFkName = `${table}_organization_id_foreign`;
    if (!(await fkExists(knex, table, newFkName))) {
      await knex.raw(
        `ALTER TABLE ??
         ADD CONSTRAINT ??
         FOREIGN KEY (organization_id) REFERENCES organizations(id)
         ON DELETE SET NULL`,
        [table, newFkName],
      );
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const table of TABLES) {
    if (!(await knex.schema.hasTable(table))) continue;

    // Reverse: first NULL any super_admin rows so the NOT NULL constraint
    // can be re-applied without data errors (there shouldn't be any in
    // practice, but be safe).
    await knex(table).whereNull("organization_id").delete();

    const fkName = `${table}_organization_id_foreign`;
    await dropFkIfExists(knex, table, fkName);

    await knex.raw(
      `ALTER TABLE ?? MODIFY COLUMN organization_id BIGINT UNSIGNED NOT NULL`,
      [table],
    );

    if (!(await fkExists(knex, table, fkName))) {
      await knex.raw(
        `ALTER TABLE ??
         ADD CONSTRAINT ??
         FOREIGN KEY (organization_id) REFERENCES organizations(id)
         ON DELETE CASCADE`,
        [table, fkName],
      );
    }
  }
}
