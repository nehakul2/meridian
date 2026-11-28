/**
 * Devnet keys. The deployer (fee payer and upgrade authority) is the caller's own funded wallet;
 * the role keys (admin, market_creator, settler, automation payer) are generated once into a
 * git-ignored folder. On devnet the admin is a plain keypair; on mainnet it is the Squads
 * multisig (D23), which these scripts never touch.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Keypair } from "@solana/web3.js";

export interface DevnetKeys {
  deployer: Keypair;
  admin: Keypair;
  creator: Keypair;
  settler: Keypair;
  /** Automation wallet: pays rent and fees (D28) and holds the devnet USDC mint authority. */
  payer: Keypair;
}

export function loadKeypair(path: string): Keypair {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]));
}

function loadOrCreate(path: string): Keypair {
  if (existsSync(path)) return loadKeypair(path);
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
  return kp;
}

export function loadDevnetKeys(dir: string, deployerPath: string): DevnetKeys {
  if (!existsSync(deployerPath)) {
    throw new Error(`deployer keypair ${deployerPath} not found: set DEPLOYER_KEYPAIR to a funded devnet wallet`);
  }
  mkdirSync(dir, { recursive: true });
  return {
    deployer: loadKeypair(deployerPath),
    admin: loadOrCreate(join(dir, "admin.json")),
    creator: loadOrCreate(join(dir, "market-creator.json")),
    settler: loadOrCreate(join(dir, "settler.json")),
    payer: loadOrCreate(join(dir, "automation-payer.json")),
  };
}
