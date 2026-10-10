import { ConflictException } from '@nestjs/common';
import { AdminUsersService } from './admin-users.service';

function makeService(sendPasswordReset: jest.Mock) {
  const users = {
    findByUsername: jest.fn().mockResolvedValue(null),
    findByEmail: jest.fn().mockResolvedValue(null),
    createUser: jest
      .fn()
      .mockResolvedValue({ id: 'u1', email: 'a@b.test', fullName: 'A' }),
    adminUserOf: jest.fn().mockResolvedValue({ id: 'u1', username: 'a' }),
  };
  const tokens = { createResetToken: jest.fn().mockResolvedValue('raw') };
  const mail = {
    sendPasswordReset,
    passwordResetUrl: jest.fn().mockReturnValue('http://x/reset'),
  };
  const service = new AdminUsersService(
    users as never,
    tokens as never,
    {} as never,
    mail as never,
  );
  return { service, users };
}

const dto = {
  name: 'A',
  username: 'a',
  email: 'a@b.test',
  role: 'viewer',
  sendInvite: true,
};

describe('AdminUsersService.create', () => {
  it('keeps the created user when the invite email fails, so a retry is not a 409', async () => {
    const { service, users } = makeService(
      jest.fn().mockRejectedValue(new Error('smtp down')),
    );
    await expect(service.create(dto, 'admin')).resolves.toEqual({
      id: 'u1',
      username: 'a',
      inviteSent: false,
    });
    expect(users.createUser).toHaveBeenCalledTimes(1);
  });

  it('reports a sent invite', async () => {
    const { service } = makeService(jest.fn().mockResolvedValue(undefined));
    await expect(service.create(dto, 'admin')).resolves.toMatchObject({
      inviteSent: true,
    });
  });

  it('does not try to invite when not asked', async () => {
    const send = jest.fn();
    const { service } = makeService(send);
    await expect(
      service.create({ ...dto, sendInvite: false }, 'admin'),
    ).resolves.toMatchObject({ inviteSent: null });
    expect(send).not.toHaveBeenCalled();
  });

  it('still rejects a duplicate username', async () => {
    const { service, users } = makeService(jest.fn());
    users.findByUsername.mockResolvedValue({ id: 'x' });
    await expect(service.create(dto, 'admin')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
