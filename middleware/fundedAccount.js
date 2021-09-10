const nearAPI = require('near-api-js');
const BN = require('bn.js');

const models = require('../models');
const recaptchaValidator = require('../RecaptchaValidator');
const { fundedCreatorKeyJson } = require('./near');

// TODO: Adjust gas to correct amounts
const MAX_GAS_FOR_ACCOUNT_CREATE = process.env.MAX_GAS_FOR_ACCOUNT_CREATE || '100000000000000';
const NEW_FUNDED_ACCOUNT_BALANCE = process.env.FUNDED_ACCOUNT_BALANCE || nearAPI.utils.format.parseNearAmount('0.35');
const FUNDED_NEW_ACCOUNT_CONTRACT_NAME = process.env.FUNDED_NEW_ACCOUNT_CONTRACT_NAME || 'near';

// DEPRECATED: Remove after coin-op v1.5 is settled
const BN_FUNDED_ACCOUNT_BALANCE_REQUIRED = (new BN(NEW_FUNDED_ACCOUNT_BALANCE).add(new BN(MAX_GAS_FOR_ACCOUNT_CREATE)));
const BN_UNLOCK_FUNDED_ACCOUNT_BALANCE = new BN(process.env.UNLOCK_FUNDED_ACCOUNT_BALANCE || nearAPI.utils.format.parseNearAmount('0.2'));

const setJSONErrorResponse = ({ ctx, statusCode, body }) => {
    ctx.status = statusCode;
    ctx.body = body;
};

async function doCreateFundedAccount({
    fundingAccount,
    newAccountId,
    newAccountPublicKey,
    ctx,
    isAccountCreatedByThisCall,
    sequelizeAccount
}) {
    try {
        const newAccountResult = await fundingAccount.functionCall(
            FUNDED_NEW_ACCOUNT_CONTRACT_NAME,
            'create_account',
            {
                new_account_id: newAccountId,
                new_public_key: newAccountPublicKey.replace(/^ed25519:/, '')
            },
            MAX_GAS_FOR_ACCOUNT_CREATE,
            NEW_FUNDED_ACCOUNT_BALANCE
        );

        ctx.body = {
            success: true,
            result: newAccountResult,
            requiredUnlockBalance: NEW_FUNDED_ACCOUNT_BALANCE
        };
    } catch (e) {
        if (isAccountCreatedByThisCall) {
            // Clean up SQL record if we were responsible for creating it during this API call
            await sequelizeAccount.destroy();
        }

        if (e.type === 'NotEnoughBalance') {
            setJSONErrorResponse({
                ctx,
                statusCode: 503,
                body: { success: false, code: 'NotEnoughBalance', message: e.message }
            });
            return;
        }

        ctx.throw(e);
    }
}

const createFundedAccount = async (ctx) => {
    if (!fundedCreatorKeyJson) {
        console.warn('FUNDED_ACCOUNT_CREATOR_KEY is not set, cannot create funded accounts.');
        ctx.throw(500, 'Funded account creation is not available.');
    }

    const {
        newAccountId,
        newAccountPublicKey,
        recaptchaCode,
    } = ctx.request.body;

    if (!newAccountId) {
        setJSONErrorResponse({
            ctx,
            statusCode: 400,
            body: { success: false, code: 'newAccountIdRequired' }
        });
        return;
    }

    if (!newAccountPublicKey) {
        setJSONErrorResponse({
            ctx,
            statusCode: 400,
            body: { success: false, code: 'newAccountPublicKeyRequired' }
        });
        return;
    }

    if (!recaptchaCode) {
        setJSONErrorResponse({
            ctx,
            statusCode: 400,
            body: { success: false, code: 'recaptchaCodeRequired' }
        });
        return;
    }

    const { success, error, code } = await recaptchaValidator.validateRecaptchaCode(recaptchaCode, ctx.ip);

    if (!success) {
        const { statusCode, message } = error;

        setJSONErrorResponse({
            ctx,
            statusCode,
            body: { success: false, code, message }
        });
        return;
    }


    const [[sequelizeAccount, isAccountCreatedByThisCall], fundingAccount] = await Promise.all([
        models.Account.findOrCreate({
            where: { accountId: newAccountId },
            defaults: { fundedAccountNeedsDeposit: true }
        }),
        ctx.near.account(fundedCreatorKeyJson.account_id)
    ]);

    if (!isAccountCreatedByThisCall) {
        // If someone is using a recovery method that involves a confirmation code (email / SMS)
        // then we need to manually set the fundedAccountNeedsDeposit on the _existing_ SQL record
        await sequelizeAccount.update({ fundedAccountNeedsDeposit: true });
    }

    await doCreateFundedAccount({
        fundingAccount,
        newAccountId,
        newAccountPublicKey,
        ctx,
        isAccountCreatedByThisCall,
        sequelizeAccount
    });
};

async function createIdentityVerifiedFundedAccount(ctx) {
    if (!fundedCreatorKeyJson) {
        console.warn('FUNDED_ACCOUNT_CREATOR_KEY is not set, cannot create funded accounts.');
        ctx.throw(500, 'Funded account creation is not available.');
    }

    const {
        type,
        newAccountId,
        newAccountPublicKey,
        identityKey,
        verificationCode
    } = ctx.request.body;

    if (!type) {
        setJSONErrorResponse({
            ctx,
            statusCode: 400,
            body: { success: false, code: 'typeRequired' }
        });
        return;
    }

    if (!newAccountId) {
        setJSONErrorResponse({
            ctx,
            statusCode: 400,
            body: { success: false, code: 'newAccountIdRequired' }
        });
        return;
    }

    if (!newAccountPublicKey) {
        setJSONErrorResponse({
            ctx,
            statusCode: 400,
            body: { success: false, code: 'newAccountPublicKeyRequired' }
        });
        return;
    }

    if (!identityKey) {
        setJSONErrorResponse({
            ctx,
            statusCode: 400,
            body: { success: false, code: 'identityKeyRequired' }
        });
        return;
    }

    if (!verificationCode) {
        setJSONErrorResponse({
            ctx,
            statusCode: 400,
            body: { success: false, code: 'verificationCodeRequired' }
        });
        return;
    }

    const verificationMethod = await models.IdentityVerificationMethod.findOne({
        where: {
            identityKey,
            kind: type,
            securityCode: verificationCode,
        }
    });

    if (!verificationMethod) {
        setJSONErrorResponse({
            ctx,
            statusCode: 400,
            body: { success: false, code: 'identityVerificationCodeInvalid' }
        });
        return;
    }

    if (verificationMethod.claimed) {
        setJSONErrorResponse({
            ctx,
            statusCode: 400,
            body: { success: false, code: 'identityVerificationCodeClaimed' }
        });
        return;
    }

    // 15 minute expiration for codes; don't allow anything older to be used.
    if ((Date.now().valueOf() - verificationMethod.updatedAt.valueOf()) > (60 * 1000 * 15)) {
        setJSONErrorResponse({
            ctx,
            statusCode: 400,
            body: { success: false, code: 'identityVerificationCodeExpired' }
        });
        return;
    }

    const [[sequelizeAccount, isAccountCreatedByThisCall], fundingAccount] = await Promise.all([
        models.Account.findOrCreate({ where: { accountId: newAccountId } }),
        ctx.near.account(fundedCreatorKeyJson.account_id)
    ]);

    await doCreateFundedAccount({
        fundingAccount,
        newAccountId,
        newAccountPublicKey,
        ctx,
        isAccountCreatedByThisCall,
        sequelizeAccount
    });

    if (ctx.status === 200) {
        await verificationMethod.update({ securityCode: null, claimed: true });
    }
}

async function clearFundedAccountNeedsDeposit(ctx) {
    // DEPRECATED: Remove after coin-op v1.5 is settled

    const { accountId, fundedAccountNeedsDeposit } = ctx.sequelizeAccount;

    if (!fundedAccountNeedsDeposit) {
        // This is an idempotent call
        ctx.status = 200;
        ctx.body = { success: true };
        return;
    }

    const nearAccount = await ctx.near.account(accountId);

    const { available } = await nearAccount.getAccountBalance();
    const availableBalanceBN = new BN(available);

    if (availableBalanceBN.gt(BN_UNLOCK_FUNDED_ACCOUNT_BALANCE)) {
        await ctx.sequelizeAccount.update({ fundedAccountNeedsDeposit: false });

        ctx.status = 200;
        ctx.body = { success: true };
        return;
    }

    setJSONErrorResponse({
        ctx,
        statusCode: 403,
        body: {
            success: false,
            code: 'NotEnoughBalance',
            message: `${accountId} does not have enough balance to be unlocked`,
            currentBalance: available,
            requiredUnlockBalance: BN_UNLOCK_FUNDED_ACCOUNT_BALANCE.toString()
        }
    });
}

const checkFundedAccountAvailable = async (ctx) => {
    // DEPRECATED: Remove after coin-op v1.5 is settled

    if (!fundedCreatorKeyJson) {
        ctx.body = { available: false };
        return;
    }

    try {
        const fundingAccount = await ctx.near.account(fundedCreatorKeyJson.account_id);

        const { available } = await fundingAccount.getAccountBalance();
        const availableBalanceBN = new BN(available);

        ctx.body = {
            available: availableBalanceBN.gt(BN_FUNDED_ACCOUNT_BALANCE_REQUIRED)
        };

        return;
    } catch (e) {
        // TODO: Sentry alert or other reporting?
        console.error('failed to calculate fund status', e);

        ctx.body = { available: false };
        return;
    }
};

module.exports = {
    checkFundedAccountAvailable,
    clearFundedAccountNeedsDeposit,
    createFundedAccount,
    createIdentityVerifiedFundedAccount,
    BN_UNLOCK_FUNDED_ACCOUNT_BALANCE
};