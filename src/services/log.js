const db = require('../db');

function log(integration, level, message) {
  try {
    db.run('INSERT INTO integration_log (integration, level, message) VALUES (?, ?, ?)', integration, level, String(message).slice(0, 2000));
    db.run('DELETE FROM integration_log WHERE id <= (SELECT MAX(id) - 1000 FROM integration_log)');
  } catch {
    // el log nunca debe romper una operación
  }
  if (level === 'error' && process.env.NODE_ENV !== 'test') console.error(`[${integration}] ${message}`);
}

const recent = (integration, limit = 50) =>
  db.all('SELECT * FROM integration_log WHERE integration = ? ORDER BY id DESC LIMIT ?', integration, limit);

module.exports = { log, recent };
