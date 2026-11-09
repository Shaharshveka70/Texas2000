// Payment provider abstraction.
//
// The MVP ships with a MOCK provider so the full flow can be demoed end to end.
// For production, implement the same `charge()` interface against a real
// Israeli clearing provider (e.g. Tranzila, CardCom, Grow/Meshulam, PayPlus)
// using their hosted payment page / hosted fields, so card numbers never
// touch our servers (keeps us out of PCI-DSS scope).
const crypto = require('node:crypto');

const METHODS = ['card', 'apple_pay', 'google_pay', 'bit'];

const mockProvider = {
  name: 'mock',
  async charge({ amount, tip, method }) {
    if (!METHODS.includes(method)) {
      return { status: 'declined', reason: 'unsupported_method' };
    }
    // Simulate a decline for a magic total so failure paths can be tested.
    if ((amount + tip) % 100000 === 99999) {
      return { status: 'declined', reason: 'card_declined' };
    }
    return { status: 'approved', ref: 'mock_' + crypto.randomBytes(6).toString('hex') };
  },
};

module.exports = { mockProvider, METHODS };
