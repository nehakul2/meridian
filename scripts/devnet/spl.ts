/** The few SPL Token instructions the devnet scripts need, built by hand (no spl-token dependency). */
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { ata, ATA_PROGRAM_ID, TOKEN_PROGRAM_ID } from "../../services/automation/src/chain/pdas.js";

export const MINT_LEN = 82;

/** SystemProgram.createAccount for a mint, then InitializeMint2 (no freeze authority). */
export function ixsCreateMint(payer: PublicKey, mint: PublicKey, authority: PublicKey, decimals: number, lamports: number) {
  const data = Buffer.alloc(1 + 1 + 32 + 1);
  data.writeUInt8(20, 0); // InitializeMint2
  data.writeUInt8(decimals, 1);
  authority.toBuffer().copy(data, 2);
  data.writeUInt8(0, 34); // no freeze authority
  return [
    SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, lamports, space: MINT_LEN, programId: TOKEN_PROGRAM_ID }),
    new TransactionInstruction({ programId: TOKEN_PROGRAM_ID, keys: [{ pubkey: mint, isSigner: false, isWritable: true }], data }),
  ];
}

/** Associated token account for `owner` (which may be a PDA), created only if missing. */
export function ixCreateAta(payer: PublicKey, owner: PublicKey, mint: PublicKey) {
  return new TransactionInstruction({
    programId: ATA_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

export function ixMintTo(mint: PublicKey, dest: PublicKey, authority: PublicKey, amount: bigint) {
  const data = Buffer.alloc(9);
  data.writeUInt8(7, 0); // MintTo
  data.writeBigUInt64LE(amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: authority, isSigner: true, isWritable: false },
    ],
    data,
  });
}

/** Token account amount (offset 64), or 0 when the account does not exist. */
export function tokenAmount(data: Uint8Array | null | undefined): bigint {
  if (!data || data.length < 72) return 0n;
  return Buffer.from(data.buffer, data.byteOffset, data.length).readBigUInt64LE(64);
}

export { ata, PublicKey };
