import TelegramBot from "node-telegram-bot-api";

export type AlertFormat = "plain" | "markdown";

export interface FormattedAlert {
  text: string;
  format: AlertFormat;
  disableWebPagePreview?: boolean;
}

export interface OwnerAlert extends FormattedAlert {
  context: string;
}

export interface ChatAlert extends OwnerAlert {
  chatId: number;
}

export function redactSecrets(value: string, botToken?: string): string {
  let out = value;
  out = out.replace(/\/bot\d+:[A-Za-z0-9_-]+/g, "/bot[REDACTED_TELEGRAM_TOKEN]");
  if (botToken) {
    out = out.split(botToken).join("[REDACTED_TELEGRAM_TOKEN]");
  }
  return out;
}

export function formatErrorForLog(err: unknown, botToken?: string): string {
  try {
    if (err instanceof Error) {
      const e = err as Error & {
        code?: string;
        response?: { body?: { description?: string } };
      };
      const codePart = e.code ? ` code=${e.code}` : "";
      const tgPart = e.response?.body?.description
        ? ` telegram=${e.response.body.description}`
        : "";
      return redactSecrets(`${e.name}: ${e.message}${codePart}${tgPart}`, botToken);
    }
    if (typeof err === "string") {
      return redactSecrets(err, botToken);
    }
    return redactSecrets(JSON.stringify(err), botToken);
  } catch {
    return "unknown_error";
  }
}

type OwnerAlertSenderConfig = {
  bot: TelegramBot;
  ownerChatId: number;
  botTokenForRedaction?: string;
};

type ChatAlertSenderConfig = {
  bot: TelegramBot;
  botTokenForRedaction?: string;
};

export function createChatAlertSender(config: ChatAlertSenderConfig) {
  return async function sendChatAlert(alert: ChatAlert): Promise<boolean> {
    const options: TelegramBot.SendMessageOptions = {
      disable_web_page_preview: alert.disableWebPagePreview ?? false,
    };

    if (alert.format === "markdown") {
      options.parse_mode = "Markdown";
    }

    try {
      await config.bot.sendMessage(alert.chatId, alert.text, options);
      return true;
    } catch (err) {
      console.error(
        `[tg-bot] failed to send ${alert.context}:`,
        formatErrorForLog(err, config.botTokenForRedaction),
      );
      return false;
    }
  };
}

export function createOwnerAlertSender(config: OwnerAlertSenderConfig) {
  const sendChatAlert = createChatAlertSender({
    bot: config.bot,
    botTokenForRedaction: config.botTokenForRedaction,
  });

  return async function sendOwnerAlert(alert: OwnerAlert): Promise<boolean> {
    return sendChatAlert({
      ...alert,
      chatId: config.ownerChatId,
    });
  };
}
