#!/usr/bin/env node
/**
 * RX PRO — Admin CLI
 *
 * Uso:
 *   node admin-cli.js generate                    → Genera 1 key
 *   node admin-cli.js generate 5                  → Genera 5 keys
 *   node admin-cli.js generate 1 "NombreCliente"  → Genera 1 key con nombre
 *   node admin-cli.js generate 1 "" 30            → Genera 1 key que expira en 30 días
 *   node admin-cli.js generate 1 "" 0 3           → Genera 1 key con 3 dispositivos máx
 *   node admin-cli.js list                        → Lista todas las keys
 *   node admin-cli.js revoke RX-VIP-XXXXXXXX      → Revoca una key
 *   node admin-cli.js delete RX-VIP-XXXXXXXX      → Elimina una key
 */

require('dotenv').config();
const { pool, initDB } = require('./database');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

const CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateKeyCode() {
  let code = 'RX-VIP-';
  for (let i = 0; i < 8; i++) {
    code += CHARS[crypto.randomInt(CHARS.length)];
  }
  return code;
}

const [,, command, ...args] = process.argv;

async function main() {
  await initDB();

  switch (command) {
    case 'generate': {
      const count = parseInt(args[0]) || 1;
      const ownerName = args[1] || '';
      const expiresInDays = parseInt(args[2]) || 0;
      const maxActivations = parseInt(args[3]) || 1;

      const expiresAt = expiresInDays > 0
        ? new Date(Date.now() + expiresInDays * 86400000).toISOString()
        : null;

      console.log('\n  ═══ RX PRO — Generador de Keys ═══\n');

      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        for (let i = 0; i < count; i++) {
          let keyCode;
          do {
            keyCode = generateKeyCode();
            const { rows } = await client.query(
              'SELECT id FROM license_keys WHERE key_code = $1',
              [keyCode]
            );
            if (rows.length === 0) break;
          } while (true);

          const keyHash = await bcrypt.hash(keyCode, 10);
          await client.query(
            'INSERT INTO license_keys (key_code, key_hash, owner_name, max_activations, expires_at) VALUES ($1, $2, $3, $4, $5)',
            [keyCode, keyHash, ownerName, maxActivations, expiresAt]
          );

          console.log(`  [${i + 1}] ${keyCode}${ownerName ? ' → ' + ownerName : ''}${expiresAt ? ' (expira: ' + expiresAt.slice(0, 10) + ')' : ' (sin expiración)'}  [max: ${maxActivations} dispositivo(s)]`);
        }

        await client.query('COMMIT');
        console.log(`\n  ✓ ${count} key(s) generada(s) exitosamente.\n`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error('  Error generando keys:', err.message);
      } finally {
        client.release();
      }
      break;
    }

    case 'list': {
      const { rows: keys } = await pool.query(`
        SELECT k.*,
          (SELECT COUNT(*) FROM activations a WHERE a.key_id = k.id AND a.is_active = 1) as active_devices
        FROM license_keys k
        ORDER BY k.created_at DESC
      `);

      console.log('\n  ═══ RX PRO — Licencias ═══\n');
      if (keys.length === 0) {
        console.log('  No hay keys registradas.\n');
      } else {
        for (const k of keys) {
          const status = k.is_revoked ? 'REVOCADA' : (k.expires_at && new Date(k.expires_at) < new Date() ? 'EXPIRADA' : 'ACTIVA');
          console.log(`  ${k.key_code}  |  ${k.owner_name || '(sin nombre)'}  |  ${status}  |  Dispositivos: ${k.active_devices}/${k.max_activations}  |  Creada: ${k.created_at}`);
        }
        console.log(`\n  Total: ${keys.length} key(s)\n`);
      }
      break;
    }

    case 'revoke': {
      const code = (args[0] || '').toUpperCase();
      if (!code) { console.log('  Uso: node admin-cli.js revoke RX-VIP-XXXXXXXX'); break; }

      const { rowCount } = await pool.query(
        'UPDATE license_keys SET is_revoked = 1 WHERE key_code = $1',
        [code]
      );

      if (rowCount === 0) {
        console.log(`\n  Key "${code}" no encontrada.\n`);
      } else {
        const { rows } = await pool.query(
          'SELECT id FROM license_keys WHERE key_code = $1',
          [code]
        );
        if (rows[0]) {
          await pool.query('UPDATE activations SET is_active = 0 WHERE key_id = $1', [rows[0].id]);
        }
        console.log(`\n  Key "${code}" revocada. Todas las sesiones han sido cerradas.\n`);
      }
      break;
    }

    case 'delete': {
      const code = (args[0] || '').toUpperCase();
      if (!code) { console.log('  Uso: node admin-cli.js delete RX-VIP-XXXXXXXX'); break; }

      const { rows } = await pool.query(
        'SELECT id FROM license_keys WHERE key_code = $1',
        [code]
      );

      if (!rows[0]) {
        console.log(`\n  Key "${code}" no encontrada.\n`);
      } else {
        await pool.query('DELETE FROM activations WHERE key_id = $1', [rows[0].id]);
        await pool.query('DELETE FROM license_keys WHERE id = $1', [rows[0].id]);
        console.log(`\n  Key "${code}" eliminada permanentemente.\n`);
      }
      break;
    }

    default:
      console.log(`
  ═══ RX PRO — Admin CLI ═══

  Comandos:
    generate [cantidad] [nombre] [dias_expiracion] [max_dispositivos]
    list
    revoke <codigo>
    delete <codigo>

  Ejemplos:
    node admin-cli.js generate                     → 1 key sin expiración
    node admin-cli.js generate 5                   → 5 keys
    node admin-cli.js generate 1 "Juan Pérez"      → 1 key con nombre
    node admin-cli.js generate 1 "" 30             → 1 key que expira en 30 días
    node admin-cli.js generate 1 "Ana" 30 2        → 1 key, 30 días, 2 dispositivos
    node admin-cli.js list                         → Listar todas
    node admin-cli.js revoke RX-VIP-XXXXXXXX       → Revocar key
    `);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
