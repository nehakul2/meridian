/**
 * Posting the stored Hermes update to the Pyth Solana Receiver (A2) and calling
 * `record_close` against the resulting `PriceUpdateV2` account. The receiver verifies the
 * Wormhole signatures in full, which `record_close` requires (`verification_level = Full`).
 */
import { Connection, Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import type { OracleUpdateRow } from "../store/types.js";
import { ChainError, parseProgramError, ProgramError } from "./client.js";

export interface PriceUpdatePoster {
  /**
   * Posts `update` (its stored bytes, unchanged) and sends `consume(account)` in the same
   * transaction set, signed by `signer`. Returns the transaction signatures.
   */
  postAndConsume(
    update: OracleUpdateRow,
    feedIdHex: string,
    signer: Keypair,
    consume: (priceUpdate: PublicKey) => TransactionInstruction[],
    priorityMicroLamports?: number,
  ): Promise<string[]>;
}

/** Production poster built on @pythnetwork/pyth-solana-receiver. */
export class PythReceiverPoster implements PriceUpdatePoster {
  constructor(private readonly conn: Connection) {}

  async postAndConsume(
    update: OracleUpdateRow,
    feedIdHex: string,
    signer: Keypair,
    consume: (priceUpdate: PublicKey) => TransactionInstruction[],
    priorityMicroLamports = 0,
  ): Promise<string[]> {
    const { PythSolanaReceiver } = await import("@pythnetwork/pyth-solana-receiver");
    const { Wallet } = await import("@coral-xyz/anchor");
    const receiver = new PythSolanaReceiver({ connection: this.conn, wallet: new Wallet(signer) as any });
    const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
    await builder.addPostPriceUpdates([Buffer.from(update.vaa).toString("base64")]);
    await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount: (id: string) => PublicKey) => {
      const acct = getPriceUpdateAccount(`0x${feedIdHex.replace(/^0x/, "")}`);
      return consume(acct).map((instruction) => ({ instruction, signers: [] }));
    });
    const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: priorityMicroLamports });
    try {
      return await receiver.provider.sendAll(txs as any, { skipPreflight: false, commitment: "confirmed" });
    } catch (e) {
      const pe = parseProgramError(e, (e as { logs?: string[] }).logs ?? []);
      if (pe) throw pe;
      if (e instanceof ProgramError) throw e;
      throw new ChainError(String((e as Error).message ?? e), true);
    }
  }
}
