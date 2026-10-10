
export function setDevENV() {
    process.env.AP_PASSWORD_SALT = "FIXTURE"
    process.env.JWT_SECRET = "fixture-jwt-secret"
    process.env.DB_DIALECT = process.env.DB_DIALECT ?? "sqlite"
    // The public site (layers/app-agentiz-site) renders through a Vite dev server locally, so a
    // checkout works without `npm run build:site` first.
    process.env.VITE_ENV = process.env.VITE_ENV ?? "dev"
}