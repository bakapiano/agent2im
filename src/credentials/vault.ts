import type { Store } from '../db/store.js';
import type { SecretProtector } from './protector.js';
import { ensure } from '../core/errors.js';
import { id, now } from '../core/util.js';
import type { ImProviderId } from '../im/catalog.js';

export class Vault {
  constructor(
    private store: Store,
    private protector: SecretProtector,
  ) {}

  async save(secret: string, purpose: ImProviderId, owner = 'local') {
    ensure(secret.length > 0 && secret.length <= 16_384, 'SECRET_INVALID', '凭据长度无效。');
    const record = {
      id: id('cred'),
      owner,
      purpose,
      ciphertext: await this.protector.protect(secret),
      createdAt: now(),
    };
    this.store.put('credential', record);
    return record.id;
  }

  verify(ref: string, purpose: ImProviderId, owner = 'local') {
    const record = this.store.get('credential', ref);
    ensure(
      record && record.owner === owner && record.purpose === purpose,
      'CREDENTIAL_REF_INVALID',
      '凭据引用的用途或所有者不匹配。',
      403,
    );
    return record;
  }

  async read(ref: string, purpose: ImProviderId, owner = 'local') {
    return this.protector.unprotect(this.verify(ref, purpose, owner).ciphertext);
  }
}
