import "dotenv/config";
import { Pool } from "pg";
import { planRoute } from "../index.ts";

async function main() {
  const [lon1, lat1, lon2, lat2, serviceDate, departSecsStr] = process.argv.slice(2);
  const pool = new Pool({ connectionString: process.env["DATABASE_URL"], max: 5 });

  const result = await planRoute(pool, {
    origin: { lon: Number(lon1), lat: Number(lat1) },
    destination: { lon: Number(lon2), lat: Number(lat2) },
    serviceDate: serviceDate!,
    departSecs: Number(departSecsStr),
  });

  console.log(JSON.stringify(result, null, 2));
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
