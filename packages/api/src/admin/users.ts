import { Types } from 'mongoose';
import { PrincipalType, SystemRoles } from 'librechat-data-provider';
import { logger, isValidObjectIdString } from '@librechat/data-schemas';
import type {
  IUser,
  IConfig,
  AdminUserListItem,
  AdminUserSearchResult,
  UserDeleteResult,
} from '@librechat/data-schemas';
import type { FilterQuery } from 'mongoose';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';
import { parsePagination } from './pagination';

const MAX_SEARCH_LENGTH = 200;

const USER_LIST_FIELDS = '_id name username email avatar role provider createdAt updatedAt';

export interface AdminUsersDeps {
  findUsers: (
    searchCriteria: FilterQuery<IUser>,
    fieldsToSelect?: string | string[] | null,
    options?: { limit?: number; offset?: number; sort?: Record<string, 1 | -1> },
  ) => Promise<IUser[]>;
  countUsers: (filter?: FilterQuery<IUser>) => Promise<number>;
  beginAgentTriggerUserDeletion: (
    userId: string,
    startedAt: Date,
  ) => Promise<'acquired' | 'in_progress' | 'missing'>;
  cancelAgentTriggerUserDeletion: (userId: string, startedAt: Date) => Promise<boolean>;
  drainAgentTriggerDeliveriesForUser: (userId: string) => Promise<void>;
  prepareAgentTriggerUserPurge: (
    userId: string,
    fenceStartedAt: Date,
    tenantId?: string,
  ) => Promise<void>;
  cancelAgentTriggerUserPurge: (userId: string, fenceStartedAt: Date) => Promise<boolean>;
  purgeAgentTriggerDeliveriesForUser: (userId: string) => Promise<void>;
  /**
   * Thin data-layer delete — removes the User document only.
   * Full cascade of user-owned resources (conversations, messages, files, tokens, etc.)
   * is handled by `UserController.deleteUserController` in the self-delete flow.
   * This admin endpoint fences durable triggers around the user commit and currently
   * cascades Config and AclEntries.
   * A future iteration should consolidate the full cascade into a shared service function.
   */
  deleteUserById: (userId: string) => Promise<UserDeleteResult>;
  deleteConfig: (
    principalType: PrincipalType,
    principalId: string | Types.ObjectId,
  ) => Promise<IConfig | null>;
  deleteAclEntries: (filter: {
    principalType: PrincipalType;
    principalId: string | Types.ObjectId;
  }) => Promise<void>;
  /** Same service the public register form and the `create-user` CLI script use. */
  registerUser: (
    user: {
      email: string;
      password: string;
      confirm_password: string;
      name: string;
      username?: string;
    },
    additionalData?: { emailVerified?: boolean; role?: string },
  ) => Promise<{ status: number; message: string }>;
  updateUser: (userId: string, updateData: Partial<IUser>) => Promise<IUser | null>;
  /** Hashes and sets a user's password directly (admin-driven, no reset token/email). */
  setPassword: (userId: string, password: string) => Promise<IUser | null>;
}

function mapListItem(u: IUser): AdminUserListItem {
  return {
    id: u._id?.toString() ?? '',
    name: u.name ?? '',
    username: u.username ?? '',
    email: u.email ?? '',
    avatar: u.avatar ?? '',
    role: u.role ?? 'USER',
    provider: u.provider ?? 'local',
    createdAt: u.createdAt?.toISOString(),
    updatedAt: u.updatedAt?.toISOString(),
  };
}

export function createAdminUsersHandlers(deps: AdminUsersDeps): {
  listUsers: (req: ServerRequest, res: Response) => Promise<Response>;
  searchUsers: (req: ServerRequest, res: Response) => Promise<Response>;
  deleteUser: (req: ServerRequest, res: Response) => Promise<Response>;
  createUser: (req: ServerRequest, res: Response) => Promise<Response>;
  updateUser: (req: ServerRequest, res: Response) => Promise<Response>;
} {
  const {
    findUsers,
    countUsers,
    beginAgentTriggerUserDeletion,
    cancelAgentTriggerUserDeletion,
    drainAgentTriggerDeliveriesForUser,
    prepareAgentTriggerUserPurge,
    cancelAgentTriggerUserPurge,
    purgeAgentTriggerDeliveriesForUser,
    deleteUserById,
    deleteConfig,
    deleteAclEntries,
    registerUser,
    updateUser,
    setPassword,
  } = deps;

  async function listUsersHandler(req: ServerRequest, res: Response) {
    try {
      const { limit, offset } = parsePagination(req.query);
      const [users, total] = await Promise.all([
        findUsers({}, USER_LIST_FIELDS, { limit, offset, sort: { createdAt: -1 } }),
        countUsers(),
      ]);

      const mapped: AdminUserListItem[] = users.map(mapListItem);

      return res.status(200).json({ users: mapped, total, limit, offset });
    } catch (error) {
      logger.error('[adminUsers] listUsers error:', error);
      return res.status(500).json({ error: 'Failed to list users' });
    }
  }

  async function searchUsersHandler(req: ServerRequest, res: Response) {
    try {
      const rawQ = req.query.q;
      const rawLimit = req.query.limit;
      const query = typeof rawQ === 'string' ? rawQ : undefined;
      const limitStr = typeof rawLimit === 'string' ? rawLimit : '20';
      const trimmed = query?.trim() ?? '';

      if (!trimmed) {
        return res.status(400).json({ error: 'Query parameter "q" is required' });
      }

      if (trimmed.length < 2) {
        return res.status(400).json({ error: 'Query must be at least 2 characters' });
      }

      if (trimmed.length > MAX_SEARCH_LENGTH) {
        return res
          .status(400)
          .json({ error: `Query must not exceed ${MAX_SEARCH_LENGTH} characters` });
      }

      const searchLimit = Math.min(Math.max(1, parseInt(limitStr, 10) || 20), 50);
      const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${escaped}`, 'i');

      const users = await findUsers(
        { $or: [{ name: regex }, { email: regex }, { username: regex }] },
        '_id name email username avatar',
        { limit: searchLimit, sort: { name: 1 } },
      );

      const results: AdminUserSearchResult[] = users.map((u) => ({
        id: u._id?.toString() ?? '',
        name: u.name ?? '',
        email: u.email ?? '',
        username: u.username,
        avatarUrl: u.avatar,
      }));

      return res
        .status(200)
        .json({ users: results, total: results.length, capped: results.length >= searchLimit });
    } catch (error) {
      logger.error('[adminUsers] searchUsers error:', error);
      return res.status(500).json({ error: 'Failed to search users' });
    }
  }

  async function deleteUserHandler(req: ServerRequest, res: Response) {
    let targetUserId: string | undefined;
    let triggerDeletionFence: Date | undefined;
    let userDeleted = false;

    try {
      const { id } = req.params as { id: string };
      targetUserId = id;

      if (!isValidObjectIdString(id)) {
        return res.status(400).json({ error: 'Invalid user ID format' });
      }

      const callerId = req.user?._id?.toString() ?? req.user?.id;
      if (callerId === id) {
        return res.status(403).json({ error: 'Cannot delete your own account' });
      }

      const [targetUser] = await findUsers({ _id: id }, 'role tenantId', { limit: 1 });
      if (targetUser?.role === SystemRoles.ADMIN) {
        const adminCount = await countUsers({ role: SystemRoles.ADMIN });
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot delete the last admin user' });
        }
      }

      triggerDeletionFence = new Date();
      const fenceState = await beginAgentTriggerUserDeletion(id, triggerDeletionFence);
      if (fenceState === 'in_progress') {
        triggerDeletionFence = undefined;
        return res.status(409).json({ error: 'User deletion is already in progress' });
      }
      if (fenceState === 'missing') {
        triggerDeletionFence = undefined;
        return res.status(404).json({ error: 'User not found' });
      }
      await prepareAgentTriggerUserPurge(id, triggerDeletionFence, targetUser?.tenantId);
      await drainAgentTriggerDeliveriesForUser(id);

      const result = await deleteUserById(id);

      if (result.deletedCount === 0) {
        await cancelAgentTriggerUserPurge(id, triggerDeletionFence);
        await cancelAgentTriggerUserDeletion(id, triggerDeletionFence);
        triggerDeletionFence = undefined;
        return res.status(404).json({ error: 'User not found' });
      }
      userDeleted = true;
      await purgeAgentTriggerDeliveriesForUser(id);

      if (targetUser?.role === SystemRoles.ADMIN) {
        const remaining = await countUsers({ role: SystemRoles.ADMIN });
        if (remaining === 0) {
          logger.error(
            `[adminUsers] CRITICAL: last admin deleted via race condition, user: ${id}. ` +
              'Manual DB intervention required to restore an ADMIN user.',
          );
        }
      }

      const objectId = new Types.ObjectId(id);
      const cleanupResults = await Promise.allSettled([
        deleteConfig(PrincipalType.USER, id),
        deleteAclEntries({ principalType: PrincipalType.USER, principalId: objectId }),
      ]);
      for (const r of cleanupResults) {
        if (r.status === 'rejected') {
          logger.error('[adminUsers] cascade cleanup failed for user:', id, r.reason);
        }
      }

      return res.status(200).json({ message: result.message || 'User deleted successfully' });
    } catch (error) {
      if (targetUserId != null && triggerDeletionFence != null && !userDeleted) {
        try {
          await cancelAgentTriggerUserPurge(targetUserId, triggerDeletionFence);
        } catch (purgeFenceError) {
          logger.error('[adminUsers] failed to disarm trigger purge recovery:', purgeFenceError);
        }
        try {
          await cancelAgentTriggerUserDeletion(targetUserId, triggerDeletionFence);
        } catch (fenceError) {
          logger.error('[adminUsers] failed to release trigger deletion fence:', fenceError);
        }
      }
      logger.error('[adminUsers] deleteUser error:', error);
      return res.status(500).json({ error: 'Failed to delete user' });
    }
  }

  async function createUserHandler(req: ServerRequest, res: Response) {
    try {
      const body = req.body as {
        email?: string;
        password?: string;
        confirm_password?: string;
        name?: string;
        username?: string;
        role?: string;
      };

      const email = body.email?.trim().toLowerCase() ?? '';
      const name = body.name?.trim() ?? '';
      const password = body.password ?? '';
      const confirmPassword = body.confirm_password ?? '';
      const username = body.username?.trim() || undefined;
      const role = body.role === SystemRoles.ADMIN ? SystemRoles.ADMIN : SystemRoles.USER;

      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'A valid email is required' });
      }
      if (!name) {
        return res.status(400).json({ error: 'Name is required' });
      }
      if (!password || password !== confirmPassword) {
        return res.status(400).json({ error: 'Passwords must match' });
      }

      const existing = await findUsers(
        { $or: [{ email }, ...(username ? [{ username }] : [])] },
        '_id',
        { limit: 1 },
      );
      if (existing.length > 0) {
        return res.status(409).json({ error: 'A user with that email or username already exists' });
      }

      const result = await registerUser(
        { email, password, confirm_password: confirmPassword, name, username },
        { emailVerified: true, role },
      );

      if (result.status !== 200) {
        return res.status(result.status).json({ error: result.message });
      }

      const [created] = await findUsers({ email }, USER_LIST_FIELDS, { limit: 1 });
      if (!created) {
        logger.error('[adminUsers] createUser: registerUser reported success but user not found', {
          email,
        });
        return res.status(500).json({ error: 'User creation could not be confirmed' });
      }

      return res.status(201).json({ user: mapListItem(created) });
    } catch (error) {
      logger.error('[adminUsers] createUser error:', error);
      return res.status(500).json({ error: 'Failed to create user' });
    }
  }

  async function updateUserHandler(req: ServerRequest, res: Response) {
    try {
      const { id } = req.params as { id: string };
      if (!isValidObjectIdString(id)) {
        return res.status(400).json({ error: 'Invalid user ID format' });
      }

      const body = req.body as {
        name?: string;
        role?: string;
        password?: string;
        confirm_password?: string;
      };
      const updates: Partial<IUser> = {};

      if (body.name !== undefined) {
        const trimmedName = body.name.trim();
        if (!trimmedName) {
          return res.status(400).json({ error: 'Name cannot be empty' });
        }
        updates.name = trimmedName;
      }

      if (body.role !== undefined) {
        if (body.role !== SystemRoles.ADMIN && body.role !== SystemRoles.USER) {
          return res.status(400).json({ error: 'Invalid role' });
        }
        updates.role = body.role;
      }

      const isPasswordChange = body.password !== undefined;
      if (isPasswordChange) {
        if (!body.password || body.password !== body.confirm_password) {
          return res.status(400).json({ error: 'Passwords must match' });
        }
      }

      if (Object.keys(updates).length === 0 && !isPasswordChange) {
        return res.status(400).json({ error: 'No changes provided' });
      }

      const [target] = await findUsers({ _id: id }, 'role', { limit: 1 });
      if (!target) {
        return res.status(404).json({ error: 'User not found' });
      }

      const isDemotingLastAdmin =
        target.role === SystemRoles.ADMIN && updates.role === SystemRoles.USER;
      if (isDemotingLastAdmin) {
        const adminCount = await countUsers({ role: SystemRoles.ADMIN });
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot demote the last admin user' });
        }
      }

      let updated: IUser | null =
        Object.keys(updates).length > 0 ? await updateUser(id, updates) : null;
      if (Object.keys(updates).length > 0 && !updated) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (isPasswordChange && body.password) {
        updated = await setPassword(id, body.password);
        if (!updated) {
          return res.status(404).json({ error: 'User not found' });
        }
      }

      return res.status(200).json({ user: mapListItem(updated as IUser) });
    } catch (error) {
      logger.error('[adminUsers] updateUser error:', error);
      return res.status(500).json({ error: 'Failed to update user' });
    }
  }

  return {
    listUsers: listUsersHandler,
    searchUsers: searchUsersHandler,
    deleteUser: deleteUserHandler,
    createUser: createUserHandler,
    updateUser: updateUserHandler,
  };
}
