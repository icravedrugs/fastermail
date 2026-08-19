import { createClient } from "@libsql/client";
const c = createClient({url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN});
console.log(JSON.stringify((await c.execute(process.argv[2])).rows, null, 1));
