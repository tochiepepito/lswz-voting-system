-- CreateTable
CREATE TABLE `admins` (
    `id` VARCHAR(191) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `displayName` VARCHAR(120) NOT NULL,
    `passwordHash` VARCHAR(255) NOT NULL,
    `role` ENUM('SUPER_ADMIN', 'ADMIN', 'AUDITOR') NOT NULL DEFAULT 'ADMIN',
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `mustChangePassword` BOOLEAN NOT NULL DEFAULT false,
    `failedLoginCount` INTEGER NOT NULL DEFAULT 0,
    `lockedUntil` DATETIME(3) NULL,
    `lastLoginAt` DATETIME(3) NULL,
    `passwordChangedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `admins_email_key`(`email`),
    INDEX `admins_isActive_idx`(`isActive`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `admin_sessions` (
    `id` VARCHAR(191) NOT NULL,
    `adminId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `ipHash` VARCHAR(64) NULL,
    `userAgentHash` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,

    UNIQUE INDEX `admin_sessions_tokenHash_key`(`tokenHash`),
    INDEX `admin_sessions_adminId_idx`(`adminId`),
    INDEX `admin_sessions_expiresAt_idx`(`expiresAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `voting_events` (
    `id` VARCHAR(191) NOT NULL,
    `slug` VARCHAR(80) NOT NULL,
    `title` VARCHAR(160) NOT NULL,
    `description` TEXT NOT NULL,
    `instructions` TEXT NULL,
    `votingType` ENUM('SINGLE_CHOICE', 'MULTIPLE_CHOICE', 'YES_NO') NOT NULL,
    `status` ENUM('DRAFT', 'SCHEDULED', 'ACTIVE', 'CLOSED', 'ARCHIVED') NOT NULL DEFAULT 'DRAFT',
    `minSelections` INTEGER NOT NULL DEFAULT 1,
    `maxSelections` INTEGER NOT NULL DEFAULT 1,
    `startsAt` DATETIME(3) NULL,
    `endsAt` DATETIME(3) NULL,
    `resultsVisibility` ENUM('HIDDEN', 'AFTER_VOTING', 'WHILE_VOTING', 'AFTER_CLOSE') NOT NULL DEFAULT 'AFTER_CLOSE',
    `maxVotesPerSession` INTEGER NOT NULL DEFAULT 1,
    `ipSoftLimit` INTEGER NOT NULL DEFAULT 8,
    `requireCaptcha` BOOLEAN NOT NULL DEFAULT false,
    `createdById` VARCHAR(191) NOT NULL,
    `publishedAt` DATETIME(3) NULL,
    `openedAt` DATETIME(3) NULL,
    `closedAt` DATETIME(3) NULL,
    `archivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `voting_events_slug_key`(`slug`),
    INDEX `voting_events_status_startsAt_idx`(`status`, `startsAt`),
    INDEX `voting_events_status_endsAt_idx`(`status`, `endsAt`),
    INDEX `voting_events_createdById_idx`(`createdById`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `voting_options` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `description` TEXT NULL,
    `imageUrl` VARCHAR(1000) NULL,
    `displayOrder` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `voting_options_eventId_displayOrder_idx`(`eventId`, `displayOrder`),
    UNIQUE INDEX `voting_options_eventId_name_key`(`eventId`, `name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `voters` (
    `id` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(64) NOT NULL,
    `normalizedName` VARCHAR(64) NOT NULL,
    `nameHash` VARCHAR(64) NOT NULL,
    `confusableKey` VARCHAR(64) NOT NULL,
    `firstSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `isBlocked` BOOLEAN NOT NULL DEFAULT false,
    `blockedReason` VARCHAR(500) NULL,

    UNIQUE INDEX `voters_nameHash_key`(`nameHash`),
    INDEX `voters_isBlocked_idx`(`isBlocked`),
    INDEX `voters_confusableKey_idx`(`confusableKey`),
    INDEX `voters_normalizedName_idx`(`normalizedName`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `voter_sessions` (
    `id` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(64) NOT NULL,
    `ipHash` VARCHAR(64) NULL,
    `userAgentHash` VARCHAR(64) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastSeenAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,
    `isBlocked` BOOLEAN NOT NULL DEFAULT false,
    `blockedReason` VARCHAR(500) NULL,
    `blockedAt` DATETIME(3) NULL,
    `voteCount` INTEGER NOT NULL DEFAULT 0,
    `claimCount` INTEGER NOT NULL DEFAULT 0,

    UNIQUE INDEX `voter_sessions_tokenHash_key`(`tokenHash`),
    INDEX `voter_sessions_expiresAt_idx`(`expiresAt`),
    INDEX `voter_sessions_ipHash_idx`(`ipHash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `event_identity_claims` (
    `id` VARCHAR(191) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NOT NULL,
    `voterId` VARCHAR(191) NOT NULL,
    `identityMethod` ENUM('IGN_SELF_DECLARED', 'DISCORD_OAUTH', 'GAME_ACCOUNT', 'VOTER_TOKEN', 'ADMIN_VERIFIED') NOT NULL DEFAULT 'IGN_SELF_DECLARED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `event_identity_claims_eventId_voterId_idx`(`eventId`, `voterId`),
    INDEX `event_identity_claims_voterId_idx`(`voterId`),
    INDEX `event_identity_claims_sessionId_idx`(`sessionId`),
    UNIQUE INDEX `event_identity_claims_eventId_sessionId_key`(`eventId`, `sessionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `votes` (
    `id` VARCHAR(191) NOT NULL,
    `receiptCode` VARCHAR(32) NOT NULL,
    `eventId` VARCHAR(191) NOT NULL,
    `voterId` VARCHAR(191) NOT NULL,
    `sessionId` VARCHAR(191) NULL,
    `identityMethod` ENUM('IGN_SELF_DECLARED', 'DISCORD_OAUTH', 'GAME_ACCOUNT', 'VOTER_TOKEN', 'ADMIN_VERIFIED') NOT NULL DEFAULT 'IGN_SELF_DECLARED',
    `status` ENUM('VALID', 'INVALIDATED') NOT NULL DEFAULT 'VALID',
    `isSuspicious` BOOLEAN NOT NULL DEFAULT false,
    `suspicionReasons` JSON NULL,
    `ipHash` VARCHAR(64) NULL,
    `userAgentHash` VARCHAR(64) NULL,
    `castAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `invalidatedAt` DATETIME(3) NULL,
    `invalidatedById` VARCHAR(191) NULL,
    `invalidationReason` VARCHAR(500) NULL,

    UNIQUE INDEX `votes_receiptCode_key`(`receiptCode`),
    INDEX `votes_eventId_castAt_idx`(`eventId`, `castAt`),
    INDEX `votes_eventId_status_idx`(`eventId`, `status`),
    INDEX `votes_eventId_ipHash_idx`(`eventId`, `ipHash`),
    INDEX `votes_sessionId_idx`(`sessionId`),
    INDEX `votes_voterId_idx`(`voterId`),
    INDEX `votes_invalidatedById_idx`(`invalidatedById`),
    UNIQUE INDEX `votes_eventId_voterId_key`(`eventId`, `voterId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vote_selections` (
    `id` VARCHAR(191) NOT NULL,
    `voteId` VARCHAR(191) NOT NULL,
    `optionId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `vote_selections_optionId_idx`(`optionId`),
    UNIQUE INDEX `vote_selections_voteId_optionId_key`(`voteId`, `optionId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` VARCHAR(191) NOT NULL,
    `action` ENUM('EVENT_CREATED', 'EVENT_UPDATED', 'EVENT_PUBLISHED', 'EVENT_UNPUBLISHED', 'EVENT_OPENED', 'EVENT_CLOSED', 'EVENT_ARCHIVED', 'EVENT_DUPLICATED', 'OPTION_CREATED', 'OPTION_UPDATED', 'OPTION_DEACTIVATED', 'OPTION_DELETED', 'VOTE_SUBMITTED', 'VOTE_DUPLICATE_BLOCKED', 'VOTE_SESSION_LIMIT_BLOCKED', 'VOTE_REJECTED', 'VOTE_FLAGGED_SUSPICIOUS', 'VOTE_INVALIDATED', 'VOTE_RESTORED', 'VOTE_VOIDED_FOR_REVOTE', 'VOTER_SESSION_CREATED', 'VOTER_IDENTITY_CLAIMED', 'VOTER_BLOCKED', 'VOTER_UNBLOCKED', 'VOTER_SESSION_BLOCKED', 'RATE_LIMIT_TRIGGERED', 'SUSPICIOUS_ACTIVITY_DETECTED', 'CAPTCHA_FAILED', 'ADMIN_LOGIN_SUCCEEDED', 'ADMIN_LOGIN_FAILED', 'ADMIN_LOGGED_OUT', 'ADMIN_LOCKED_OUT', 'ADMIN_CREATED', 'ADMIN_UPDATED', 'ADMIN_DEACTIVATED', 'ADMIN_PASSWORD_CHANGED', 'RESULTS_EXPORTED') NOT NULL,
    `severity` ENUM('INFO', 'NOTICE', 'WARNING', 'CRITICAL') NOT NULL DEFAULT 'INFO',
    `actorType` ENUM('ADMIN', 'VOTER', 'SYSTEM') NOT NULL,
    `actorLabel` VARCHAR(254) NULL,
    `adminId` VARCHAR(191) NULL,
    `eventId` VARCHAR(191) NULL,
    `voterId` VARCHAR(191) NULL,
    `voterSessionId` VARCHAR(191) NULL,
    `ipHash` VARCHAR(64) NULL,
    `userAgentHash` VARCHAR(64) NULL,
    `summary` TEXT NOT NULL,
    `metadata` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_logs_createdAt_idx`(`createdAt`),
    INDEX `audit_logs_eventId_createdAt_idx`(`eventId`, `createdAt`),
    INDEX `audit_logs_action_createdAt_idx`(`action`, `createdAt`),
    INDEX `audit_logs_severity_createdAt_idx`(`severity`, `createdAt`),
    INDEX `audit_logs_voterId_idx`(`voterId`),
    INDEX `audit_logs_adminId_idx`(`adminId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rate_limit_records` (
    `id` VARCHAR(191) NOT NULL,
    `scope` ENUM('VOTE_SESSION', 'VOTE_IP', 'CLAIM_IP', 'ADMIN_LOGIN_IP', 'ADMIN_LOGIN_ACCOUNT') NOT NULL,
    `bucketKey` VARCHAR(64) NOT NULL,
    `identifierHash` VARCHAR(64) NOT NULL,
    `windowStart` DATETIME(3) NOT NULL,
    `windowEnd` DATETIME(3) NOT NULL,
    `count` INTEGER NOT NULL DEFAULT 0,
    `blockedCount` INTEGER NOT NULL DEFAULT 0,
    `lastHitAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `rate_limit_records_bucketKey_key`(`bucketKey`),
    INDEX `rate_limit_records_scope_windowEnd_idx`(`scope`, `windowEnd`),
    INDEX `rate_limit_records_identifierHash_scope_idx`(`identifierHash`, `scope`),
    INDEX `rate_limit_records_windowEnd_idx`(`windowEnd`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `admin_sessions` ADD CONSTRAINT `admin_sessions_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `admins`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `voting_events` ADD CONSTRAINT `voting_events_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `admins`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `voting_options` ADD CONSTRAINT `voting_options_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `voting_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_identity_claims` ADD CONSTRAINT `event_identity_claims_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `voting_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_identity_claims` ADD CONSTRAINT `event_identity_claims_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `voter_sessions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `event_identity_claims` ADD CONSTRAINT `event_identity_claims_voterId_fkey` FOREIGN KEY (`voterId`) REFERENCES `voters`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `votes` ADD CONSTRAINT `votes_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `voting_events`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `votes` ADD CONSTRAINT `votes_voterId_fkey` FOREIGN KEY (`voterId`) REFERENCES `voters`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `votes` ADD CONSTRAINT `votes_sessionId_fkey` FOREIGN KEY (`sessionId`) REFERENCES `voter_sessions`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `votes` ADD CONSTRAINT `votes_invalidatedById_fkey` FOREIGN KEY (`invalidatedById`) REFERENCES `admins`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vote_selections` ADD CONSTRAINT `vote_selections_voteId_fkey` FOREIGN KEY (`voteId`) REFERENCES `votes`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vote_selections` ADD CONSTRAINT `vote_selections_optionId_fkey` FOREIGN KEY (`optionId`) REFERENCES `voting_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_adminId_fkey` FOREIGN KEY (`adminId`) REFERENCES `admins`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_eventId_fkey` FOREIGN KEY (`eventId`) REFERENCES `voting_events`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

