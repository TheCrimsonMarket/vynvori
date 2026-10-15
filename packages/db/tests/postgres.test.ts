import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { connectDatabase } from "../src/index";
test("PostgreSQL constraints, transaction rollback and migration readiness", { skip: !process.env.M2_CREATIVE_DATABASE_URL }, async () => {
  const connection = connectDatabase(process.env);
  try {
    await connection.ready();
    const client = await connection.pool.connect();
    const id = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO vynvori_infrastructure.synthetic_probes(id, fixture) VALUES ($1, $2)", [id, "m2-synthetic-v1"]);
      await client.query("SAVEPOINT duplicate_probe");
      await assert.rejects(client.query("INSERT INTO vynvori_infrastructure.synthetic_probes(id, fixture) VALUES ($1, $2)", [id, "m2-synthetic-v1"]), { code: "23505" });
      await client.query("ROLLBACK TO SAVEPOINT duplicate_probe");
      await assert.rejects(client.query("INSERT INTO vynvori_infrastructure.synthetic_probes(id, fixture) VALUES ($1, $2)", [randomUUID(), "customer-data"]), { code: "23514" });
      await client.query("ROLLBACK");
      const result = await client.query("SELECT id FROM vynvori_infrastructure.synthetic_probes WHERE id = $1", [id]);
      assert.equal(result.rowCount, 0);
    } finally { await client.query("ROLLBACK"); client.release(); }
  } finally { await connection.close(); }
});
