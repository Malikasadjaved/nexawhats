/**
 * LID (WhatsApp Linked Identity) ↔ PN (phone number) mapping store.
 *
 * Ported from Baileys `Signal/lid-mapping.js`. WhatsApp now addresses
 * users by a LID on the wire; we keep a cached bidirectional map so
 * Signal sessions and routing stay consistent across device changes.
 *
 * Differences from the Baileys reference:
 * - Baileys wraps all writes in `keys.transaction(work, 'lid-mapping')`
 *   for batching + retry. Our `SignalKeyStore` has no `transaction()`,
 *   but `setKeys()` is already atomic per-call (SQLite WAL). We therefore
 *   issue one combined `set({ 'lid-mapping': { ... } })` with every
 *   forward + reverse entry in a single call — same semantics, no
 *   nested mutex.
 * - USync batch resolution (`pnToLIDFunc`) is optional; when absent and a
 *   mapping is missing, the miss is simply recorded and returned as null
 *   rather than attempting a network fetch.
 */
import { LRUCache } from 'lru-cache';
import type { Logger } from 'pino';
import {
  WAJIDDomains,
  isHostedPnUser,
  isLidUser,
  isPnUser,
  jidDecode,
  jidNormalizedUser,
} from '../binary/jid.js';
import type { SignalKeyStore } from '../types/auth.js';

export interface LIDPNPair {
  lid: string;
  pn: string;
}

export type PnToLidFunc = (pns: string[]) => Promise<LIDPNPair[] | undefined>;

/**
 * Cache TTL mirrors Baileys: 3 days sliding, auto-purge.
 * Reference comment in Baileys says "7 days" but the literal is 3 days;
 * we follow the literal to preserve behaviour.
 */
const MAPPING_TTL_MS = 3 * 24 * 60 * 60 * 1000;

export class LIDMappingStore {
  private readonly keys: SignalKeyStore;
  private readonly logger: Logger;
  private readonly pnToLIDFunc?: PnToLidFunc;
  private readonly mappingCache: LRUCache<string, string>;

  constructor(keys: SignalKeyStore, logger: Logger, pnToLIDFunc?: PnToLidFunc) {
    this.keys = keys;
    this.logger = logger;
    this.pnToLIDFunc = pnToLIDFunc;
    this.mappingCache = new LRUCache<string, string>({
      ttl: MAPPING_TTL_MS,
      ttlAutopurge: true,
      updateAgeOnGet: true,
      max: 10000,
    });
  }

  /**
   * Store LID-PN mappings at the USER level (device-independent).
   *
   * Validates each pair (one side must be LID, the other PN), skips
   * duplicates already in the cache/DB, and writes every new pair plus
   * its reverse entry in a single atomic `setKeys` call.
   */
  async storeLIDPNMappings(pairs: LIDPNPair[]): Promise<void> {
    const pairMap: Record<string, string> = {};

    for (const { lid, pn } of pairs) {
      if (!((isLidUser(lid) && isPnUser(pn)) || (isPnUser(lid) && isLidUser(pn)))) {
        this.logger.warn(`Invalid LID-PN mapping: ${lid}, ${pn}`);
        continue;
      }

      const lidDecoded = jidDecode(lid);
      const pnDecoded = jidDecode(pn);
      if (!lidDecoded || !pnDecoded) return;

      const pnUser = pnDecoded.user;
      const lidUser = lidDecoded.user;

      let existingLidUser = this.mappingCache.get(`pn:${pnUser}`);
      if (!existingLidUser) {
        this.logger.trace(`Cache miss for PN user ${pnUser}; checking database`);
        const stored = await this.keys.get('lid-mapping', [pnUser]);
        existingLidUser = stored[pnUser];
        if (existingLidUser) {
          this.mappingCache.set(`pn:${pnUser}`, existingLidUser);
          this.mappingCache.set(`lid:${existingLidUser}`, pnUser);
        }
      }

      if (existingLidUser === lidUser) {
        this.logger.debug({ pnUser, lidUser }, 'LID mapping already exists, skipping');
        continue;
      }

      pairMap[pnUser] = lidUser;
    }

    const newPairs = Object.keys(pairMap);
    this.logger.trace({ pairMap }, `Storing ${newPairs.length} pn mappings`);
    if (newPairs.length === 0) return;

    const batch: Record<string, string> = {};
    for (const [pnUser, lidUser] of Object.entries(pairMap)) {
      batch[pnUser] = lidUser;
      batch[`${lidUser}_reverse`] = pnUser;
    }
    await this.keys.set({ 'lid-mapping': batch });

    for (const [pnUser, lidUser] of Object.entries(pairMap)) {
      this.mappingCache.set(`pn:${pnUser}`, lidUser);
      this.mappingCache.set(`lid:${lidUser}`, pnUser);
    }
  }

  /**
   * Resolve a single PN JID to its device-specific LID JID, or null if
   * no mapping exists (and USync did not produce one).
   */
  async getLIDForPN(pn: string): Promise<string | null> {
    const result = await this.getLIDsForPNs([pn]);
    return result?.[0]?.lid ?? null;
  }

  /**
   * Batch-resolve PN JIDs to LID JIDs. Cache hits return immediately;
   * misses are grouped and forwarded to `pnToLIDFunc` (USync) when
   * available. Returns null only if every miss fails resolution.
   */
  async getLIDsForPNs(pns: string[]): Promise<LIDPNPair[] | null> {
    const usyncFetch: Record<string, number[]> = {};
    const successfulPairs: Record<string, LIDPNPair> = {};

    for (const pn of pns) {
      if (!isPnUser(pn) && !isHostedPnUser(pn)) continue;
      const decoded = jidDecode(pn);
      if (!decoded) continue;

      const pnUser = decoded.user;
      let lidUser = this.mappingCache.get(`pn:${pnUser}`);

      if (!lidUser) {
        const stored = await this.keys.get('lid-mapping', [pnUser]);
        lidUser = stored[pnUser];
        if (lidUser) {
          this.mappingCache.set(`pn:${pnUser}`, lidUser);
          this.mappingCache.set(`lid:${lidUser}`, pnUser);
        } else {
          this.logger.trace(`No LID mapping found for PN user ${pnUser}; batch getting from USync`);
          const device = decoded.device || 0;
          let normalizedPn = jidNormalizedUser(pn);
          if (isHostedPnUser(normalizedPn)) {
            normalizedPn = `${pnUser}@s.whatsapp.net`;
          }
          if (!usyncFetch[normalizedPn]) {
            usyncFetch[normalizedPn] = [device];
          } else {
            usyncFetch[normalizedPn].push(device);
          }
          continue;
        }
      }

      lidUser = String(lidUser);
      if (!lidUser) {
        this.logger.warn(`Invalid or empty LID user for PN ${pn}: lidUser = "${lidUser}"`);
        return null;
      }

      const pnDevice = decoded.device !== undefined ? decoded.device : 0;
      const deviceSpecificLid = `${lidUser}${pnDevice ? `:${pnDevice}` : ''}@${
        decoded.server === 'hosted' ? 'hosted.lid' : 'lid'
      }`;
      this.logger.trace(
        `getLIDForPN: ${pn} → ${deviceSpecificLid} (user mapping with device ${pnDevice})`,
      );
      successfulPairs[pn] = { lid: deviceSpecificLid, pn };
    }

    const fetchTargets = Object.keys(usyncFetch);
    if (fetchTargets.length > 0) {
      const result = await this.pnToLIDFunc?.(fetchTargets);
      if (result && result.length > 0) {
        await this.storeLIDPNMappings(result);
        for (const pair of result) {
          const pnDecoded = jidDecode(pair.pn);
          const pnUser = pnDecoded?.user;
          if (!pnUser) continue;
          const lidUser = jidDecode(pair.lid)?.user;
          if (!lidUser) continue;

          const devices = usyncFetch[pair.pn];
          if (!devices) continue;

          for (const device of devices) {
            const deviceSpecificLid = `${lidUser}${device ? `:${device}` : ''}@${
              device === 99 ? 'hosted.lid' : 'lid'
            }`;
            this.logger.trace(
              `getLIDForPN: USYNC success for ${pair.pn} → ${deviceSpecificLid} (user mapping with device ${device})`,
            );
            const deviceSpecificPn = `${pnUser}${device ? `:${device}` : ''}@${
              device === 99 ? 'hosted' : 's.whatsapp.net'
            }`;
            successfulPairs[deviceSpecificPn] = {
              lid: deviceSpecificLid,
              pn: deviceSpecificPn,
            };
          }
        }
      } else {
        return null;
      }
    }

    return Object.values(successfulPairs);
  }

  /**
   * Resolve a LID JID back to its device-specific PN JID. Returns null
   * if no reverse mapping is stored.
   */
  async getPNForLID(lid: string): Promise<string | null> {
    if (!isLidUser(lid)) return null;
    const decoded = jidDecode(lid);
    if (!decoded) return null;

    const lidUser = decoded.user;
    let pnUser = this.mappingCache.get(`lid:${lidUser}`);
    if (!pnUser || typeof pnUser !== 'string') {
      const stored = await this.keys.get('lid-mapping', [`${lidUser}_reverse`]);
      pnUser = stored[`${lidUser}_reverse`];
      if (!pnUser || typeof pnUser !== 'string') {
        this.logger.trace(`No reverse mapping found for LID user: ${lidUser}`);
        return null;
      }
      this.mappingCache.set(`lid:${lidUser}`, pnUser);
    }

    const lidDevice = decoded.device !== undefined ? decoded.device : 0;
    const pnJid = `${pnUser}:${lidDevice}@${
      decoded.domainType === WAJIDDomains.HOSTED_LID ? 'hosted' : 's.whatsapp.net'
    }`;
    this.logger.trace(`Found reverse mapping: ${lid} → ${pnJid}`);
    return pnJid;
  }
}
