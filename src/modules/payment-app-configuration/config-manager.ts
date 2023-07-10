import { uuidv7 } from "uuidv7";
import { validateStripeKeys } from "../stripe/stripe-api";
import { type ConfigEntryUpdate } from "./input-schemas";
import { obfuscateConfigEntry } from "./utils";
import { type PaymentAppConfigurator } from "./payment-app-configuration";
import {
  type PaymentAppConfigEntryFullyConfigured,
  type PaymentAppFormConfigEntry,
} from "./config-entry";
import { createStripeWebhook, deleteStripeWebhook } from "./webhook-manager";
import { createLogger, redactError, redactLogObject } from "@/lib/logger";
import { BaseError } from "@/errors";

export const EntryNotFoundError = BaseError.subclass("EntryNotFoundError");

export const getAllConfigEntriesObfuscated = async (configurator: PaymentAppConfigurator) => {
  const logger = createLogger(
    { saleorApiUrl: configurator.saleorApiUrl },
    { msgPrefix: "[getAllConfigEntriesObfuscated] " },
  );

  const config = await configurator.getConfigObfuscated();
  logger.debug("Got obfuscated config");

  return config.configurations;
};

export const getAllConfigEntriesDecrypted = async (configurator: PaymentAppConfigurator) => {
  const logger = createLogger(
    { saleorApiUrl: configurator.saleorApiUrl },
    { msgPrefix: "[getAllConfigEntriesDecrypted] " },
  );

  const config = await configurator.getConfig();
  logger.debug("Got config");

  return config.configurations;
};

export const getConfigEntryObfuscated = async (
  configurationId: string,
  configurator: PaymentAppConfigurator,
) => {
  const logger = createLogger(
    { configurationId, saleorApiUrl: configurator.saleorApiUrl },
    { msgPrefix: "[getConfigEntryObfuscated] " },
  );
  logger.debug("Fetching all config entries");
  const entries = await getAllConfigEntriesObfuscated(configurator);
  const entry = entries.find((entry) => entry.configurationId === configurationId);
  if (!entry) {
    logger.warn("Entry was not found");
    throw new EntryNotFoundError(`Entry with id ${configurationId} was not found`);
  }
  logger.debug({ entryName: entry.configurationName }, "Found entry");
  return entry;
};

export const getConfigEntryDecrypted = async (
  configurationId: string,
  configurator: PaymentAppConfigurator,
) => {
  const logger = createLogger(
    { configurationId, saleorApiUrl: configurator.saleorApiUrl },
    { msgPrefix: "[getConfigEntryDecrypted] " },
  );

  logger.debug("Fetching all config entries");
  const entries = await getAllConfigEntriesDecrypted(configurator);
  const entry = entries.find((entry) => entry.configurationId === configurationId);
  if (!entry) {
    logger.warn("Entry was not found");
    throw new EntryNotFoundError(`Entry with id ${configurationId} was not found`);
  }
  logger.debug({ entryName: entry.configurationName }, "Found entry");
  return entry;
};

export const addConfigEntry = async (
  newConfigEntry: PaymentAppFormConfigEntry,
  configurator: PaymentAppConfigurator,
  appUrl: string,
) => {
  const logger = createLogger(
    { saleorApiUrl: configurator.saleorApiUrl },
    { msgPrefix: "[addConfigEntry] " },
  );

  await validateStripeKeys(newConfigEntry.secretKey, newConfigEntry.publishableKey);

  logger.debug("Creating new webhook for config entry");
  const { webhookSecret, webhookId } = await createStripeWebhook({
    appUrl,
    secretKey: newConfigEntry.secretKey,
    saleorApiUrl: configurator.saleorApiUrl,
    configurator,
  });

  const uuid = uuidv7();
  const config = {
    ...newConfigEntry,
    webhookSecret,
    webhookId,
    configurationId: uuid,
  } satisfies PaymentAppConfigEntryFullyConfigured;

  logger.debug({ config: redactLogObject(config) }, "Adding new config entry");
  await configurator.setConfigEntry(config);
  logger.info({ configurationId: config.configurationId }, "Config entry added");

  return obfuscateConfigEntry(config);
};

export const updateConfigEntry = async (
  input: ConfigEntryUpdate,
  configurator: PaymentAppConfigurator,
) => {
  const logger = createLogger(
    { saleorApiUrl: configurator.saleorApiUrl },
    { msgPrefix: "[updateConfigEntry] " },
  );

  const { entry, configurationId } = input;
  logger.debug("Checking if config entry with provided ID exists");
  const existingEntry = await getConfigEntryDecrypted(configurationId, configurator);
  logger.debug({ existingEntry: redactLogObject(existingEntry) }, "Found entry");

  await configurator.setConfigEntry({
    ...entry,
    configurationId,
  });
  logger.info({ configurationId }, "Config entry updated");

  return obfuscateConfigEntry({
    ...existingEntry,
    ...entry,
  });
};

export const deleteConfigEntry = async (
  configurationId: string,
  configurator: PaymentAppConfigurator,
) => {
  const logger = createLogger(
    { configurationId, saleorApiUrl: configurator.saleorApiUrl },
    { msgPrefix: "[deleteConfigEntry] " },
  );

  logger.debug("Checking if config entry with provided ID exists");
  const entries = await getAllConfigEntriesDecrypted(configurator);
  const existingEntry = entries.find((entry) => entry.configurationId === configurationId);

  if (!existingEntry) {
    logger.error({ configurationId }, "Entry was not found");
    throw new EntryNotFoundError(`Entry with id ${configurationId} was not found`);
  }

  logger.debug({ existingEntry: redactLogObject(existingEntry) }, "Found entry");

  logger.debug(
    { webhookId: existingEntry.webhookId },
    "Checking if other config is using assosiated webhook",
  );

  const otherEntries = entries.filter((entry) => entry.configurationId !== configurationId);
  const isWebhookUsed = otherEntries.some((entry) => entry.webhookId === existingEntry.webhookId);

  if (!isWebhookUsed) {
    logger.debug("Deleting webhook linked with config entry");
    try {
      await deleteStripeWebhook({
        webhookId: existingEntry.webhookId,
        secretKey: existingEntry.secretKey,
      });
    } catch (e) {
      // Ignore error
      logger.warn(
        { error: redactError(e), webhookId: existingEntry.webhookId },
        "Webhook couldn't be deleted with the config",
      );
    }
  } else {
    logger.debug("Webhook linked with deleted config entry is used by other config entries");
  }

  await configurator.deleteConfigEntry(configurationId);
  logger.info({ configurationId }, "Config entry deleted");
};
