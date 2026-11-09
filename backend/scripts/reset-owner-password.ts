import bcrypt from 'bcryptjs';
import { StoreMembership, User } from '../src/database/models/index.js';
import { sequelize } from '../src/database/sequelize.js';

const emailInput = process.env.OWNER_EMAIL?.trim().toLowerCase();
const password = process.env.OWNER_NEW_PASSWORD;

try {
  const ownerMemberships = await StoreMembership.findAll({
    where: { role: 'owner' },
    attributes: ['userId'],
    raw: true
  });
  const ownerIds = [...new Set(ownerMemberships.map(({ userId }) => userId))];
  const owners = await User.findAll({
    where: { id: ownerIds },
    attributes: ['id', 'email', 'isActive'],
    order: [['email', 'ASC']]
  });

  if (!emailInput || !password) {
    console.info('Owner accounts registered in this local database:');
    for (const owner of owners) {
      console.info(`- ${owner.email}${owner.isActive ? '' : ' (inactive)'}`);
    }
    console.info('To reset one, set OWNER_EMAIL and OWNER_NEW_PASSWORD for this command.');
    process.exitCode = 1;
  } else {
    if (password.length < 12 || Buffer.byteLength(password, 'utf8') > 72) {
      throw new Error('OWNER_NEW_PASSWORD must be between 12 and 72 bytes.');
    }

    const owner = owners.find((candidate) => candidate.email === emailInput);
    if (!owner || !owner.isActive) {
      throw new Error('The selected email does not belong to an active owner account.');
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await sequelize.transaction(async (transaction) => {
      await User.update(
        { passwordHash },
        { where: { id: owner.id, isActive: true }, transaction }
      );
    });

    console.info(`Password updated for owner account: ${owner.email}`);
  }
} finally {
  await sequelize.close();
}
