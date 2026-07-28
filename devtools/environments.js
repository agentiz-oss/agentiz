export function setDevENV() {
    process.env.AP_PASSWORD_SALT = "FIXTURE";
    process.env.JWT_SECRET = "fixture-jwt-secret";
}
