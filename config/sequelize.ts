import fs from "node:fs";
import path from "node:path";
import { Sequelize } from "sequelize-typescript";

const truthy = new Set(["1", "true", "yes", "on"]);

function toBool(value?: string): boolean {
  return value ? truthy.has(value.toLowerCase()) : false;
}

function createPostgresConnection(): Sequelize {
  return new Sequelize({
    dialect: "postgres",
    host: process.env.DB_HOST ?? "127.0.0.1",
    port: Number(process.env.DB_PORT ?? 5432),
    username: process.env.DB_USER ?? "postgres",
    password: process.env.DB_PASS ?? "postgres",
    database: process.env.DB_NAME ?? "agentiz",
    logging: toBool(process.env.DB_LOGGING),
  });
}

function createSqliteConnection(): Sequelize {
  const storage = path.resolve(process.cwd(), process.env.DB_STORAGE ?? "./.tmp/app-db.sqlite");
  fs.mkdirSync(path.dirname(storage), { recursive: true });

  return new Sequelize({
    dialect: "sqlite",
    storage,
    logging: toBool(process.env.DB_LOGGING),
  });
}

export function createSequelize(): Sequelize {
  const dialect = (process.env.DB_DIALECT ?? "sqlite").toLowerCase();
  return dialect === "postgres" ? createPostgresConnection() : createSqliteConnection();
}
