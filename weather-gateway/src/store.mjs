// All redemption writes are synchronous and in one transaction. This class
// runs inside ONE named Durable Object; do not distribute redemption over KV.
export class AuthStore {
  constructor(storage, clock = () => Math.floor(Date.now() / 1000)) {
    this.storage = storage;
    this.sql = storage.sql;
    this.clock = clock;
    this.sql.exec('CREATE TABLE IF NOT EXISTS redeemed (jti TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, expires INTEGER NOT NULL)');
  }
  redeem(claims, hash) {
    return this.storage.transactionSync(() => {
      const now = this.clock();
      if (claims.exp <= now) return null;
      this.sql.exec('DELETE FROM redeemed WHERE expires <= ?', now);
      this.sql.exec('DELETE FROM sessions WHERE expires <= ?', now);
      const inserted = this.sql.exec(
        'INSERT OR IGNORE INTO redeemed (jti, expires) VALUES (?, ?) RETURNING jti',
        claims.jti, claims.exp,
      ).toArray();
      if (inserted.length !== 1) return null;
      const expires = now + 600;
      this.sql.exec('INSERT INTO sessions (hash, expires) VALUES (?, ?)', hash, expires);
      return expires;
    });
  }
  check(hash) {
    const row = this.sql.exec('SELECT expires FROM sessions WHERE hash = ?', hash).toArray()[0];
    return row && row.expires > this.clock() ? row.expires : null;
  }
  revoke(hash) { this.sql.exec('DELETE FROM sessions WHERE hash = ?', hash); }
}
