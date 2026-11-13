/**
 * 演示库 demo.sqlite：内置只读业务数据（V3 校验和不变）。
 * 只在首次启动时以可写方式创建；运行期所有查询都用 { readOnly:true } 打开。
 *
 * 干净模式（打包态）：**只建表结构，不插任何一行**。
 * 表结构是 SQL 浏览功能的前提（用户接入真实库后会用到同样的表名）；
 * 而那 8 行假订单、2 个假用户、'9月大促' 之类的行是演示素材，不能带出去。
 * 干净的库打开就是 0 行 —— 用户看到的是「空表，等你接入真实数据」。
 */
import fs from 'node:fs';
import { CLEAN_MODE, DEMO_DB_PATH, ensureDirs } from '../config';
import { sqliteCtor } from './adapter';

const ORDER_ROWS: [number, number, string, number, string, string | null, string][] = [
  [9821431, 77301, 'PENDING', 1299.0, 'APP', null, '2026-11-12 14:02:41'],
  [9821430, 41128, 'PENDING', 268.5, 'WEB', null, '2026-11-12 14:02:39'],
  [9821429, 90210, 'PAID', 4800.0, 'APP', '加急', '2026-11-12 14:02:38'],
  [9821428, 33017, 'PAID', 99.0, 'MINI', null, '2026-11-12 14:02:34'],
  [9821427, 5544, 'CLOSED', 1050.0, 'WEB', '', '2026-11-12 14:02:31'],
  [9821426, 61209, 'PAID', 328.0, 'APP', null, '2026-11-12 14:02:29'],
  [9821425, 18872, 'PENDING', 2199.0, 'APP', '待补发票', '2026-11-12 14:02:27'],
  [9821424, 7401, 'PAID', 76.0, 'MINI', null, '2026-11-12 14:02:25'],
];

/** 幂等创建演示库；已存在且已有数据时不改动一个字节。 */
export function initDemoDatabase(): void {
  ensureDirs();
  const Sqlite = sqliteCtor();
  const database = new Sqlite(DEMO_DB_PATH);
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS "order" (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        amount REAL NOT NULL,
        channel TEXT,
        remark TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS order_item (
        id INTEGER PRIMARY KEY, sku TEXT NOT NULL, qty INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS "user" (
        id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT
      );
      CREATE TABLE IF NOT EXISTS payment (
        id INTEGER PRIMARY KEY, order_id INTEGER, amount REAL, state TEXT
      );
      CREATE TABLE IF NOT EXISTS slow_log (
        id INTEGER PRIMARY KEY, statement TEXT, duration REAL, created_at TEXT
      );
      CREATE TABLE IF NOT EXISTS inventory (
        sku TEXT PRIMARY KEY, stock INTEGER, warehouse TEXT
      );
      CREATE TABLE IF NOT EXISTS campaign (
        id INTEGER PRIMARY KEY, name TEXT, budget REAL
      );
      CREATE INDEX IF NOT EXISTS idx_order_status ON "order"(status, created_at);
    `);
    const row = database.prepare('SELECT COUNT(*) AS n FROM "order"').get() as { n: number } | undefined;
    if ((row?.n ?? 0) > 0) return;

    /* 干净模式：建好表就收工，不插演示行。 */
    if (CLEAN_MODE) {
      // eslint-disable-next-line no-console
      console.log('[DevWork] 干净模式：演示库仅建表结构，0 行数据');
      return;
    }

    const insert = database.prepare(
      'INSERT INTO "order" (id,user_id,status,amount,channel,remark,created_at) VALUES (?,?,?,?,?,?,?)',
    );
    ORDER_ROWS.forEach((entry) => {
      insert.run(entry[0], entry[1], entry[2], entry[3], entry[4], entry[5], entry[6]);
    });
    database.exec(`
      INSERT INTO order_item (id,sku,qty) VALUES (1,'SKU-1001',2),(2,'SKU-2002',1),(3,'SKU-3003',5);
      INSERT INTO "user" (id,name,email) VALUES (77301,'陈晨','chen@example.com'),(41128,'刘洋','liu@example.com');
      INSERT INTO payment (id,order_id,amount,state) VALUES (1,9821429,4800.00,'SETTLED'),(2,9821428,99.00,'SETTLED');
      INSERT INTO slow_log (id,statement,duration,created_at) VALUES
        (1,'SELECT * FROM order_item WHERE sku = ''SKU-1001''',3.42,'2026-11-12 13:58:02'),
        (2,'SELECT count(*) FROM "order" WHERE status = ''PENDING''',2.11,'2026-11-12 13:59:44');
      INSERT INTO inventory (sku,stock,warehouse) VALUES ('SKU-1001',128,'华东'),('SKU-2002',64,'华北');
      INSERT INTO campaign (id,name,budget) VALUES (1,'9月大促',120000);
    `);
  } finally {
    database.close();
  }
}

export function demoExists(): boolean {
  return fs.existsSync(DEMO_DB_PATH);
}
