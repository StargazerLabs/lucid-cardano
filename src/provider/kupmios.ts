import {
  Address,
  Assets,
  Credential,
  Datum,
  DatumHash,
  Delegation,
  OutRef,
  ProtocolParameters,
  Provider,
  RewardAddress,
  Transaction,
  TxHash,
  Unit,
  UTxO,
} from "../types/mod.ts";
import { C } from "../core/mod.ts";
import { fromHex, fromUnit, toHex } from "../utils/mod.ts";
import WebSocket from "npm:ws@8.18.0";

export class Kupmios implements Provider {
  /**
   * Obtain the a JWT cookie after making a call using the clientId and clientSecret.
   * For more information, please refer to:
   * https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
   */
  cfAuthorizationCookie: string | null = null;

  /**
   * @param kupoUrl: http(s)://localhost:1442
   * @param ogmiosUrl: ws(s)://localhost:1337
   * @param clientId: Cloudflare Access Client ID
   * @param clientSecret: Cloudflare Access Client Secret
   */
  constructor(
    private kupoUrl: string,
    private ogmiosUrl: string,
    private clientId: string,
    private clientSecret: string
  ) {}

  private async getAuthHeaders(): Promise<Headers> {
    const headers = new Headers();
    if (this.cfAuthorizationCookie) {
      headers.set("Cookie", `CF_Authorization=${this.cfAuthorizationCookie}`);
    } else {
      headers.set("CF-Access-Client-Id", this.clientId);
      headers.set("CF-Access-Client-Secret", this.clientSecret);
    }
    return headers;
  }

  private async authenticatedFetch(
    url: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const headers = await this.getAuthHeaders();
    const response = await fetch(url, {
      ...options,
      headers,
      ...Object.fromEntries(headers),
    });

    if (response.headers.has("Set-Cookie")) {
      const cookieHeader = response.headers.get("Set-Cookie");
      if (cookieHeader) {
        const match = cookieHeader.match(/CF_Authorization=([^;]+)/);
        if (match) {
          this.cfAuthorizationCookie = match[1];
        }
      }
    }
    return response;
  }

  async getProtocolParameters(): Promise<ProtocolParameters> {
    const client = await this.rpc("queryLedgerState/protocolParameters");

    return new Promise((res, rej) => {
      client.addEventListener(
        "message",
        (msg: MessageEvent<string>) => {
          try {
            const { result } = JSON.parse(msg.data);

            // deno-lint-ignore no-explicit-any
            const costModels: any = {};
            Object.keys(result.plutusCostModels).forEach((v) => {
              const version = v.split(":")[1].toUpperCase();
              const plutusVersion = "Plutus" + version;
              costModels[plutusVersion] = result.plutusCostModels[v];
            });
            const [memNum, memDenom] =
              result.scriptExecutionPrices.memory.split("/");
            const [stepsNum, stepsDenom] =
              result.scriptExecutionPrices.cpu.split("/");

            res({
              minFeeA: parseInt(result.minFeeCoefficient),
              minFeeB: parseInt(result.minFeeConstant.ada.lovelace),
              maxTxSize: parseInt(result.maxTransactionSize.bytes),
              maxValSize: parseInt(result.maxValueSize.bytes),
              keyDeposit: BigInt(result.stakeCredentialDeposit.ada.lovelace),
              poolDeposit: BigInt(result.stakePoolDeposit.ada.lovelace),
              priceMem: parseInt(memNum) / parseInt(memDenom),
              priceStep: parseInt(stepsNum) / parseInt(stepsDenom),
              maxTxExMem: BigInt(result.maxExecutionUnitsPerTransaction.memory),
              maxTxExSteps: BigInt(result.maxExecutionUnitsPerTransaction.cpu),
              coinsPerUtxoByte: BigInt(result.minUtxoDepositCoefficient),
              collateralPercentage: parseInt(result.collateralPercentage),
              maxCollateralInputs: parseInt(result.maxCollateralInputs),
              costModels,
              minfeeRefscriptCostPerByte: parseInt(
                result.minFeeReferenceScripts.base
              ),
            });
            client.close();
          } catch (e) {
            rej(e);
          }
        },
        { once: true }
      );
    });
  }

  async getUtxos(addressOrCredential: Address | Credential): Promise<UTxO[]> {
    const isAddress = typeof addressOrCredential === "string";
    const queryPredicate = isAddress
      ? addressOrCredential
      : addressOrCredential.hash;
    const result = await this.authenticatedFetch(
      `${this.kupoUrl}/matches/${queryPredicate}${
        isAddress ? "" : "/*"
      }?unspent`
    ).then((res) => res.json());
    return this.kupmiosUtxosToUtxos(result);
  }

  async getUtxosWithUnit(
    addressOrCredential: Address | Credential,
    unit: Unit
  ): Promise<UTxO[]> {
    const isAddress = typeof addressOrCredential === "string";
    const queryPredicate = isAddress
      ? addressOrCredential
      : addressOrCredential.hash;
    const { policyId, assetName } = fromUnit(unit);
    const result = await this.authenticatedFetch(
      `${this.kupoUrl}/matches/${queryPredicate}${
        isAddress ? "" : "/*"
      }?unspent&policy_id=${policyId}${
        assetName ? `&asset_name=${assetName}` : ""
      }`
    ).then((res) => res.json());
    return this.kupmiosUtxosToUtxos(result);
  }

  async getUtxoByUnit(unit: Unit): Promise<UTxO> {
    const { policyId, assetName } = fromUnit(unit);
    const result = await this.authenticatedFetch(
      `${this.kupoUrl}/matches/${policyId}.${
        assetName ? `${assetName}` : "*"
      }?unspent`
    ).then((res) => res.json());

    const utxos = await this.kupmiosUtxosToUtxos(result);

    if (utxos.length > 1) {
      throw new Error("Unit needs to be an NFT or only held by one address.");
    }

    return utxos[0];
  }

  async getUtxosByOutRef(outRefs: Array<OutRef>): Promise<UTxO[]> {
    const queryHashes = [...new Set(outRefs.map((outRef) => outRef.txHash))];

    const utxos = await Promise.all(
      queryHashes.map(async (txHash) => {
        const result = await this.authenticatedFetch(
          `${this.kupoUrl}/matches/*@${txHash}?unspent`
        ).then((res) => res.json());
        return this.kupmiosUtxosToUtxos(result);
      })
    );

    return utxos
      .reduce((acc, utxos) => acc.concat(utxos), [])
      .filter((utxo) =>
        outRefs.some(
          (outRef) =>
            utxo.txHash === outRef.txHash &&
            utxo.outputIndex === outRef.outputIndex
        )
      );
  }

  async getDelegation(rewardAddress: RewardAddress): Promise<Delegation> {
    const client = await this.rpc(
      "queryLedgerState/rewardAccountSummaries",
      { keys: [rewardAddress] } // TODO: Does this work for reward addresses that are scripts as well?
    );

    return new Promise((res, rej) => {
      client.addEventListener(
        "message",
        (msg: MessageEvent<string>) => {
          try {
            const { result } = JSON.parse(msg.data);
            const delegation = (result ? Object.values(result)[0] : {}) as {
              delegate: { id: string };
              rewards: { ada: { lovelace: number } };
            };
            res({
              poolId: delegation?.delegate.id || null,
              rewards: BigInt(delegation?.rewards.ada.lovelace || 0),
            });
            client.close();
          } catch (e) {
            rej(e);
          }
        },
        { once: true }
      );
    });
  }

  async getDatum(datumHash: DatumHash): Promise<Datum> {
    const result = await this.authenticatedFetch(
      `${this.kupoUrl}/datums/${datumHash}`
    ).then((res) => res.json());
    if (!result || !result.datum) {
      throw new Error(`No datum found for datum hash: ${datumHash}`);
    }
    return result.datum;
  }

  awaitTx(txHash: TxHash, checkInterval = 3000): Promise<boolean> {
    return new Promise((res) => {
      const confirmation = setInterval(async () => {
        const isConfirmed = await this.authenticatedFetch(
          `${this.kupoUrl}/matches/*@${txHash}?unspent`
        ).then((res) => res.json());
        if (isConfirmed && isConfirmed.length > 0) {
          clearInterval(confirmation);
          await new Promise((res) => setTimeout(() => res(1), 1000));
          return res(true);
        }
      }, checkInterval);
    });
  }

  async submitTx(tx: Transaction): Promise<TxHash> {
    const client = await this.rpc("submitTransaction", {
      transaction: { cbor: tx },
    });

    return new Promise((res, rej) => {
      client.addEventListener(
        "message",
        (msg: MessageEvent<string>) => {
          try {
            const { result, error } = JSON.parse(msg.data);

            if (result?.transaction) res(result.transaction.id);
            else rej(error);
            client.close();
          } catch (e) {
            rej(e);
          }
        },
        { once: true }
      );
    });
  }

  private kupmiosUtxosToUtxos(utxos: unknown): Promise<UTxO[]> {
    // deno-lint-ignore no-explicit-any
    return Promise.all(
      (utxos as any).map(async (utxo: any) => {
        return {
          txHash: utxo.transaction_id,
          outputIndex: parseInt(utxo.output_index),
          address: utxo.address,
          assets: (() => {
            const a: Assets = { lovelace: BigInt(utxo.value.coins) };
            Object.keys(utxo.value.assets).forEach((unit) => {
              a[unit.replace(".", "")] = BigInt(utxo.value.assets[unit]);
            });
            return a;
          })(),
          datumHash: utxo?.datum_type === "hash" ? utxo.datum_hash : null,
          datum:
            utxo?.datum_type === "inline"
              ? await this.getDatum(utxo.datum_hash)
              : null,
          scriptRef:
            utxo.script_hash &&
            (await (async () => {
              const { script, language } = await this.authenticatedFetch(
                `${this.kupoUrl}/scripts/${utxo.script_hash}`
              ).then((res) => res.json());

              if (language === "native") {
                return { type: "Native", script };
              } else if (language === "plutus:v1") {
                return {
                  type: "PlutusV1",
                  script: toHex(C.PlutusScript.new(fromHex(script)).to_bytes()),
                };
              } else if (language === "plutus:v2") {
                return {
                  type: "PlutusV2",
                  script: toHex(C.PlutusScript.new(fromHex(script)).to_bytes()),
                };
              }
            })()),
        } as UTxO;
      })
    );
  }

  private async rpc(method: string, params?: unknown): Promise<WebSocket> {
    const headers = await this.getAuthHeaders();
    const client = new WebSocket(this.ogmiosUrl, {
      headers: Object.fromEntries(headers),
    });
    await new Promise((res) => {
      client.addEventListener("open", () => res(1), { once: true });
    });
    client.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        params,
      })
    );
    return client;
  }
}
