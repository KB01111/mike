import { SQLDatabase } from "encore.dev/storage/sqldb";

export const mikeDb = new SQLDatabase("mike", {
  migrations: "./migrations",
});
