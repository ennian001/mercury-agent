import { tool } from 'ai';
import { z } from 'zod';

export function createSendMessageTool(
  sendMessage: (content: string) => Promise<void>,
) {
  return tool({
    description:
      'Send a message to the paired user through the configured outbound channel. Currently this sends only to the paired Telegram owner. Use this only when the user explicitly asks you to send something to Telegram or asks for scheduled results to be sent there.',
    parameters: z.object({
      content: z.string().describe('The message content to send to the paired Telegram owner'),
    }),
    execute: async ({ content }) => {
      const trimmed = content.trim();
      if (!trimmed) {
        return 'Error: Message content cannot be empty.';
      }

      try {
        await sendMessage(trimmed);
        return 'Message sent to the paired Telegram owner.';
      } catch (err: any) {
        return `Error sending message: ${err.message}`;
      }
    },
  });
}
