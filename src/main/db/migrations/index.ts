import init001 from './001_init.sql?raw';
import appMeta002 from './002_app_meta.sql?raw';
import queueStrategy003 from './003_queue_strategy.sql?raw';
import batchIndex004 from './004_batch_index.sql?raw';
import outputSubdir005 from './005_output_subdir.sql?raw';
import creators006 from './006_creators.sql?raw';
import itemCaptionMode007 from './007_item_caption_mode.sql?raw';
import linkLedger008 from './008_link_ledger.sql?raw';
import itemBusyMs009 from './009_item_busy_ms.sql?raw';
import itemStage010 from './010_item_stage.sql?raw';
import itemLookup011 from './011_item_lookup.sql?raw';
import type { Migration } from '../migrator';

/**
 * The migration registry.
 *
 * SQL stays in real `.sql` files (reviewable, diffable, syntax-highlighted)
 * and is inlined at build time via Vite's `?raw`, so nothing has to locate a
 * file on disk at runtime — which is what would otherwise break inside a
 * packaged asar. Vitest shares Vite's resolver, so tests load the identical
 * strings the app ships.
 *
 * Append only. Never renumber or edit a migration that has shipped.
 */
export const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: '001_init', sql: init001 },
  { version: 2, name: '002_app_meta', sql: appMeta002 },
  { version: 3, name: '003_queue_strategy', sql: queueStrategy003 },
  { version: 4, name: '004_batch_index', sql: batchIndex004 },
  { version: 5, name: '005_output_subdir', sql: outputSubdir005 },
  { version: 6, name: '006_creators', sql: creators006 },
  { version: 7, name: '007_item_caption_mode', sql: itemCaptionMode007 },
  { version: 8, name: '008_link_ledger', sql: linkLedger008 },
  { version: 9, name: '009_item_busy_ms', sql: itemBusyMs009 },
  { version: 10, name: '010_item_stage', sql: itemStage010 },
  { version: 11, name: '011_item_lookup', sql: itemLookup011 },
];
