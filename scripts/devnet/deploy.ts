/**
 * MER-80 `make deploy-devnet`: deploy (or upgrade) the program, initialise Config once, apply the
 * devnet settings and record the program id and IDL hash in deployments/devnet.json.
 * Idempotent: rerunning upgrades the binary and leaves an existing Config, mint and vaults alone.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Keypair, PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import { coder, metas, PROGRAM_ID } from "../../services/automation/src/chain/idl.js";
import { ata, bondAuthority, configPda } from "../../services/automation/src/chain/pdas.js";
import type { Cluster } from "./cluster.js";
import { ixFund } from "./cluster.js";
import type { DevnetKeys } from "./keys.js";
import { ixCreateAta, ixsCreateMint, MINT_LEN } from "./spl.js";

export const MAG7 = ["AAPL", "MSFT", "GOOGL", "AMZN", "NVDA", "META", "TSLA"];
const LOADER_UPGRADEABLE = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");

/** Config values that differ from the program defaults on devnet. */
export interface DevnetSettings {
  /** D8 is 20 min; devnet shortens it so the lifecycle smoke finishes in minutes. */
  disputeWindowS: number;
  /** Fees are 0 on devnet (D28). */
  feeBps: number;
}
export const DEFAULT_DEVNET_SETTINGS: DevnetSettings = { disputeWindowS: 60, feeBps: 0 };

export interface DeploymentRecord {
  cluster: string;
  programId: string;
  idlSha256: string;
  soSha256: string;
  commit: string;
  deployedAt: string;
  deploySignature: string | null;
  usdcMint: string;
  /** Holds the devnet test-USDC mint authority (the automation payer). */
  usdcMintAuthority: string;
  feeVault: string;
  bondVault: string;
  roles: { admin: string; marketCreator: string; settler: string; payer: string; upgradeAuthority: string };
  tickers: Record<string, string>;
  settings: DevnetSettings;
}

export interface DeployOptions {
  cluster: Cluster;
  keys: DevnetKeys;
  soPath: string;
  idlPath: string;
  /** Public key of the program keypair passed to `solana program deploy`. */
  programKeypair: PublicKey;
  /** Pyth feed id (hex) per ticker; resolved from Hermes when not given. */
  feeds: Record<string, string>;
  previous: DeploymentRecord | null;
  settings?: DevnetSettings;
  commit: string;
  /** SOL moved from the deployer to each role key when it holds less. */
  funding?: { payer: number; other: number };
  log?: (m: string) => void;
}

export const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

export class DeployError extends Error {}

const bn = (v: number | bigint) => new BN(v.toString());

export function ixInitializeConfig(deployer: PublicKey, usdcMint: PublicKey, k: { admin: PublicKey; creator: PublicKey; settler: PublicKey }, feeVault: PublicKey, bondVault: PublicKey, feeds: Record<string, string>) {
  const programData = PublicKey.findProgramAddressSync([PROGRAM_ID.toBuffer()], LOADER_UPGRADEABLE)[0];
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas("initialize_config", {
      deployer, config: configPda(), usdc_mint: usdcMint, program: PROGRAM_ID, program_data: programData,
      system_program: SystemProgram.programId,
    }),
    data: coder.instruction.encode("initialize_config", {
      args: {
        admin: k.admin, market_creator: k.creator, settler: k.settler, fee_vault: feeVault, bond_vault: bondVault,
        tickers: Object.entries(feeds).map(([symbol, hex]) => ({ symbol, feed_id: [...Buffer.from(hex, "hex")] })),
      },
    }),
  });
}

const NONE = {
  admin: null, market_creator: null, settler: null, fee_bps: null, fee_vault: null, override_delay_s: null, settle_window_s: null,
  conf_bps_max: null, close_tolerance_bps: null, dispute_window_s: null, dispute_bond: null, dispute_resolution_s: null,
  bond_vault: null, close_source_mode: null, tickers: null,
};

export function ixUpdateConfig(admin: PublicKey, update: Partial<Record<keyof typeof NONE, unknown>>) {
  return new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: metas("update_config", { admin, config: configPda() }),
    data: coder.instruction.encode("update_config", { update: { ...NONE, ...update } }),
  });
}

export async function deployDevnet(o: DeployOptions): Promise<DeploymentRecord> {
  const log = o.log ?? (() => {});
  const settings = o.settings ?? DEFAULT_DEVNET_SETTINGS;
  const { cluster, keys } = o;
  await cluster.assertSafe();
  if (!o.programKeypair.equals(PROGRAM_ID)) {
    throw new DeployError(
      `program keypair ${o.programKeypair.toBase58()} does not match the program id ${PROGRAM_ID.toBase58()} in declare_id! and the IDL. ` +
        "Use the matching keypair, or switch the program id with scripts/devnet/set-program-id.sh and rebuild.",
    );
  }
  const roles = [keys.admin, keys.creator, keys.settler].map((k) => k.publicKey.toBase58());
  if (new Set(roles).size !== 3) throw new DeployError("admin, market_creator and settler must be different keys (D23)");

  const record: DeploymentRecord = {
    cluster: cluster.kind,
    programId: PROGRAM_ID.toBase58(),
    idlSha256: sha256(o.idlPath),
    soSha256: sha256(o.soPath),
    commit: o.commit,
    deployedAt: new Date().toISOString(),
    deploySignature: null,
    usdcMint: "",
    usdcMintAuthority: keys.payer.publicKey.toBase58(),
    feeVault: "",
    bondVault: "",
    roles: {
      admin: keys.admin.publicKey.toBase58(), marketCreator: keys.creator.publicKey.toBase58(), settler: keys.settler.publicKey.toBase58(),
      payer: keys.payer.publicKey.toBase58(), upgradeAuthority: keys.deployer.publicKey.toBase58(),
    },
    tickers: o.feeds,
    settings,
  };

  log(`deploying ${record.programId} (so ${record.soSha256.slice(0, 12)}, idl ${record.idlSha256.slice(0, 12)})`);
  record.deploySignature = (await cluster.deployer.deploy(o.soPath)).signature;

  // Role keys need SOL: the payer for market rent (an order book is ~90 KB), the others for fees.
  const funding = o.funding ?? { payer: 3, other: 0.05 };
  const fund: TransactionInstruction[] = [];
  for (const [k, sol] of [[keys.payer, funding.payer], [keys.admin, funding.other], [keys.creator, funding.other], [keys.settler, funding.other]] as const) {
    const want = Math.round(sol * 1e9);
    const have = await cluster.lamports(k.publicKey);
    if (have < want) fund.push(ixFund(keys.deployer, k.publicKey, want - have));
  }
  if (fund.length) await cluster.sender.send(fund, [keys.deployer]);

  // Test USDC: our own 6-decimal mint, so the lifecycle can fund users (Circle's devnet USDC can't be minted).
  let usdcMint = o.previous?.usdcMint ? new PublicKey(o.previous.usdcMint) : null;
  if (!usdcMint || !(await cluster.reader.getAccount(usdcMint))) {
    const mint = Keypair.generate();
    await cluster.sender.send(
      ixsCreateMint(keys.payer.publicKey, mint.publicKey, keys.payer.publicKey, 6, await cluster.rentExempt(MINT_LEN)),
      [keys.payer, mint],
    );
    usdcMint = mint.publicKey;
    log(`created devnet USDC mint ${usdcMint.toBase58()}`);
  }
  record.usdcMint = usdcMint.toBase58();

  const cfgAcct = await cluster.reader.getAccount(configPda());
  let feeVault = ata(keys.admin.publicKey, usdcMint);
  let bondVault = ata(bondAuthority(), usdcMint);
  if (!cfgAcct) {
    await cluster.sender.send(
      [ixCreateAta(keys.payer.publicKey, keys.admin.publicKey, usdcMint), ixCreateAta(keys.payer.publicKey, bondAuthority(), usdcMint)],
      [keys.payer],
    );
    await cluster.sender.send(
      [ixInitializeConfig(keys.deployer.publicKey, usdcMint, { admin: keys.admin.publicKey, creator: keys.creator.publicKey, settler: keys.settler.publicKey }, feeVault, bondVault, o.feeds)],
      [keys.deployer],
    );
    log("initialized Config");
  } else {
    const d = coder.accounts.decode("Config", Buffer.from(cfgAcct.data)) as Record<string, any>;
    const mismatch = [
      ["admin", d.admin, keys.admin], ["market_creator", d.market_creator, keys.creator], ["settler", d.settler, keys.settler],
    ].filter(([, onChain, kp]) => !(onChain as PublicKey).equals((kp as Keypair).publicKey)).map(([n]) => n);
    if (mismatch.length) throw new DeployError(`Config already exists with different ${mismatch.join(", ")}: use the role keys it was initialised with`);
    if (!(d.usdc_mint as PublicKey).equals(usdcMint)) throw new DeployError(`Config uses USDC mint ${d.usdc_mint}, deployment record says ${usdcMint}`);
    feeVault = d.fee_vault;
    bondVault = d.bond_vault;
    log("Config already initialised; kept");
  }
  record.feeVault = feeVault.toBase58();
  record.bondVault = bondVault.toBase58();

  await cluster.sender.send(
    [ixUpdateConfig(keys.admin.publicKey, {
      dispute_window_s: bn(settings.disputeWindowS),
      fee_bps: settings.feeBps,
      tickers: Object.entries(o.feeds).map(([symbol, hex]) => ({ symbol, feed_id: [...Buffer.from(hex, "hex")] })),
    })],
    [keys.admin],
  );
  log(`devnet settings applied: dispute window ${settings.disputeWindowS}s, fee ${settings.feeBps} bps`);
  return record;
}
