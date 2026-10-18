import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!columns.some((column) => column.name === "thread_folders_json")) {
    // Existing projects simply have no folders; new rows always write the list.
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN thread_folders_json TEXT NOT NULL DEFAULT '[]'
    `;
  }
});
