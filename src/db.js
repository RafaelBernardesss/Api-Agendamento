const base = require('./rawdb');
const { FIELDS, encWhere, encData, decResult } = require('./lib/pii');

const prisma = base.$extends({
  name: 'pii-encryption',
  query: {
    $allModels: {
      async $allOperations({ model, args, query }) {
        if (FIELDS[model] && args) {
          const a = { ...args };
          if (a.where) a.where = encWhere(model, a.where);
          if (a.data) a.data = encData(model, a.data);
          if (a.create) a.create = encData(model, a.create);
          if (a.update) a.update = encData(model, a.update);
          args = a;
        }
        return decResult(await query(args));
      },
    },
  },
});

module.exports = prisma;
