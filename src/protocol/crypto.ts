import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  scrypt as scryptCallback,
} from "node:crypto";
import {
  AES_GCM_NONCE_BYTES,
  AES_GCM_TAG_BYTES,
  AES_KEY_BYTES,
  CRYPTO_CONTEXT,
  PROTOCOL_VERSION,
  REPOSITORY_FORMAT,
  SCRYPT_MAX_MEMORY,
  SCRYPT_N,
  SCRYPT_P,
  SCRYPT_R,
} from "../constants";
import type { RepositoryFile, RepositoryKdf, WrappedKey } from "../types";
import { canonicalBytes, hasExactObjectKeys } from "./canonical";

export interface CreatedRepository {
  repository: RepositoryFile;
  masterKey: Buffer;
}

export async function createEncryptedRepository(
  passphrase: string,
  repositoryId: string,
): Promise<CreatedRepository> {
  const salt = randomBytes(16);
  const kdf: RepositoryKdf = {
    algorithm: "scrypt",
    salt: salt.toString("base64"),
    n: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    keyLength: AES_KEY_BYTES,
  };
  const masterKey = randomBytes(AES_KEY_BYTES);
  const wrappingKey = await derivePassphraseKey(passphrase, kdf);
  const repositoryBase = {
    format: REPOSITORY_FORMAT as RepositoryFile["format"],
    protocolVersion: PROTOCOL_VERSION,
    repositoryId,
    createdAt: new Date().toISOString(),
    kdf,
  };
  const wrappedMasterKey = encryptAead(
    wrappingKey,
    masterKey,
    canonicalBytes(repositoryBase),
  );

  return {
    repository: {
      ...repositoryBase,
      wrappedMasterKey,
    },
    masterKey,
  };
}

export async function unlockRepository(
  passphrase: string,
  repository: RepositoryFile,
): Promise<Buffer> {
  validateRepositoryFile(repository);
  const wrappingKey = await derivePassphraseKey(passphrase, repository.kdf);
  const repositoryBase = {
    format: repository.format,
    protocolVersion: repository.protocolVersion,
    repositoryId: repository.repositoryId,
    createdAt: repository.createdAt,
    kdf: repository.kdf,
  };
  const masterKey = decryptAead(
    wrappingKey,
    repository.wrappedMasterKey,
    canonicalBytes(repositoryBase),
  );
  if (masterKey.length !== AES_KEY_BYTES) {
    throw new Error("Repository master key has an invalid length.");
  }
  return masterKey;
}

export function deriveSubkey(masterKey: Uint8Array, purpose: string): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      masterKey,
      Buffer.from(CRYPTO_CONTEXT, "utf8"),
      Buffer.from(purpose, "utf8"),
      AES_KEY_BYTES,
    ),
  );
}

export function encryptAead(
  key: Uint8Array,
  plaintext: Uint8Array,
  additionalData: Uint8Array,
): WrappedKey {
  const nonce = randomBytes(AES_GCM_NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(additionalData);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    nonce: nonce.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    tag: tag.toString("base64"),
  };
}

export function decryptAead(
  key: Uint8Array,
  wrapped: WrappedKey,
  additionalData: Uint8Array,
): Buffer {
  const nonce = Buffer.from(wrapped.nonce, "base64");
  const ciphertext = Buffer.from(wrapped.ciphertext, "base64");
  const tag = Buffer.from(wrapped.tag, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAAD(additionalData);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

async function derivePassphraseKey(
  passphrase: string,
  kdf: RepositoryKdf,
): Promise<Buffer> {
  // An empty passphrase is allowed and means "no passphrase": the wrapping key
  // is derived from the salt alone, so the master key stored in the repository
  // is recoverable by anyone who can read it. A non-empty passphrase must still
  // meet the minimum so a short one cannot give a false sense of protection.
  if (passphrase.length > 0 && passphrase.length < 12) {
    throw new Error("The repository passphrase must contain at least 12 characters.");
  }
  return new Promise<Buffer>((resolve, reject) => {
    scryptCallback(
      passphrase,
      Buffer.from(kdf.salt, "base64"),
      kdf.keyLength,
      {
        N: kdf.n,
        r: kdf.r,
        p: kdf.p,
        maxmem: SCRYPT_MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error !== null) {
          reject(error);
        } else {
          resolve(Buffer.from(derivedKey));
        }
      },
    );
  });
}

export function validateRepositoryFile(repository: RepositoryFile): void {
  if (
    !hasExactObjectKeys(repository, [
      "format",
      "protocolVersion",
      "repositoryId",
      "createdAt",
      "kdf",
      "wrappedMasterKey",
    ]) ||
    !hasExactObjectKeys(repository.kdf, [
      "algorithm",
      "salt",
      "n",
      "r",
      "p",
      "keyLength",
    ])
  ) {
    throw new Error("Repository envelope contains unknown or missing fields.");
  }
  if (repository.format !== REPOSITORY_FORMAT) {
    throw new Error("The selected folder is not a Cursor Setting Sync repository.");
  }
  if (repository.protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`Unsupported repository protocol: ${repository.protocolVersion}`);
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      repository.repositoryId,
    ) ||
    !Number.isFinite(Date.parse(repository.createdAt))
  ) {
    throw new Error("Repository identity is invalid.");
  }
  const algorithm = (repository.kdf as { algorithm: string }).algorithm;
  if (algorithm !== "scrypt") {
    throw new Error(`Unsupported repository KDF: ${algorithm}`);
  }
  const salt = Buffer.from(repository.kdf.salt, "base64");
  if (
    repository.kdf.n !== SCRYPT_N ||
    repository.kdf.r !== SCRYPT_R ||
    repository.kdf.p !== SCRYPT_P ||
    repository.kdf.keyLength !== AES_KEY_BYTES ||
    salt.byteLength !== 16 ||
    salt.toString("base64") !== repository.kdf.salt ||
    !isWrappedKey(repository.wrappedMasterKey)
  ) {
    throw new Error("Repository cryptographic parameters are invalid.");
  }
}

function isWrappedKey(value: WrappedKey): boolean {
  if (
    !hasExactObjectKeys(value, ["nonce", "ciphertext", "tag"]) ||
    typeof value.nonce !== "string" ||
    typeof value.ciphertext !== "string" ||
    typeof value.tag !== "string"
  ) {
    return false;
  }
  const nonce = Buffer.from(value.nonce, "base64");
  const ciphertext = Buffer.from(value.ciphertext, "base64");
  const tag = Buffer.from(value.tag, "base64");
  return (
    nonce.byteLength === AES_GCM_NONCE_BYTES &&
    ciphertext.byteLength === AES_KEY_BYTES &&
    tag.byteLength === AES_GCM_TAG_BYTES &&
    nonce.toString("base64") === value.nonce &&
    ciphertext.toString("base64") === value.ciphertext &&
    tag.toString("base64") === value.tag
  );
}
