import 'server-only'

import {
  createAI,
  createStreamableUI,
  getMutableAIState,
  getAIState,
  streamUI,
  createStreamableValue
} from 'ai/rsc'
import { openai } from '@ai-sdk/openai'
import { BotMessage, SpinnerMessage, UserMessage } from '@/components/stocks/message'
import { z } from 'zod'
import { nanoid } from '@/lib/utils'
import { saveChat } from '@/app/actions'
import { auth } from '@/auth'
import { Chat, Message } from '@/lib/types'


async function submitUserMessage(content: string) {
  'use server'

  const aiState = getMutableAIState<typeof AI>()

  aiState.update({
    ...aiState.get(),
    messages: [
      ...aiState.get().messages,
      {
        id: nanoid(),
        role: 'user',
        content
      }
    ]
  })

  let textStream: undefined | ReturnType<typeof createStreamableValue<string>>
  let textNode: undefined | React.ReactNode

  const result = await streamUI({
    model: openai('gpt-3.5-turbo'),
    initial: <SpinnerMessage />,
    system: `\
     You are a support article writer for a cloud communications company called RingCentral.
    You and the user work together to create support articles in the RingCentral tone and style.
    If the user requests searching similar KB/Support article, call \`similarity_search\` to perform nearest neighbor search on the vector database of support articles.

    `,
    messages: [
      ...aiState.get().messages.map((message: any) => ({
        role: message.role,
        content: message.content,
        name: message.name
      }))
    ],
    text: ({ content, done, delta }) => {
      if (!textStream) {
        textStream = createStreamableValue('')
        textNode = <BotMessage content={textStream.value} />
      }

      if (done) {
        textStream.done()
        aiState.done({
          ...aiState.get(),
          messages: [
            ...aiState.get().messages,
            {
              id: nanoid(),
              role: 'assistant',
              content
            }
          ]
        })
      } else {
        textStream.update(delta)
      }

      return textNode
    },
    tools: {
      listArticles: {
        description: 'Get a list of articles similar to the query.',
        parameters: z.object({
          query: z.string().describe('The query string to search for similar articles.')
        }),
        generate: async function* ({ query }) {
          const toolCallId = nanoid();
      
          // Function to perform similarity search based on the query
          const similarArticles = await SimilaritySearch(query);
      
          aiState.done({
            ...aiState.get(),
            messages: [
              ...aiState.get().messages,
              {
                id: nanoid(),
                role: 'assistant',
                content: [
                  {
                    type: 'tool-call',
                    toolName: 'listArticles',
                    toolCallId,
                    args: { query }
                  }
                ]
              },
              {
                id: nanoid(),
                role: 'tool',
                content: [
                  {
                    type: 'tool-result',
                    toolName: 'listArticles',
                    toolCallId,
                    result: similarArticles
                  }
                ]
              }
            ]
          });
      
          return (
            <div>
              {similarArticles}
            </div>
          );
        }
      }
    }
  })

  return {
    id: nanoid(),
    display: result.value
  }
}

export type AIState = {
  chatId: string
  messages: Message[]
}

export type UIState = {
  id: string
  display: React.ReactNode
}[]

export const AI = createAI<AIState, UIState>({
  actions: {
    submitUserMessage
  },
  initialUIState: [],
  initialAIState: { chatId: nanoid(), messages: [] },
  onGetUIState: async () => {
    'use server'

    const session = await auth()

    if (session && session.user) {
      const aiState = getAIState() as Chat

      if (aiState) {
        const uiState = getUIStateFromAIState(aiState)
        return uiState
      }
    } else {
      return
    }
  },
  onSetAIState: async ({ state }) => {
    'use server'

    const session = await auth()

    if (session && session.user) {
      const { chatId, messages } = state

      const createdAt = new Date()
      const userId = session.user.id as string
      const path = `/chat/${chatId}`

      const firstMessageContent = messages[0].content as string
      const title = firstMessageContent.substring(0, 100)

      const chat: Chat = {
        id: chatId,
        title,
        userId,
        createdAt,
        messages,
        path
      }

      await saveChat(chat)
    } else {
      return
    }
  }
})

export const getUIStateFromAIState = (aiState: Chat) => {
  return aiState.messages
    .filter(message => message.role !== 'system')
    .map((message, index) => ({
      id: `${aiState.chatId}-${index}`,
      display:
        message.role === 'user' ? (
          <UserMessage>{message.content as string}</UserMessage>
        ) : message.role === 'assistant' &&
          typeof message.content === 'string' ? (
          <BotMessage content={message.content} />
        ) : null
    }))
}







// async function SimilaritySearch(query: string) {
//   return [
//     { id: 1, title: 'Article 1', content: 'Content for article 1 related to ' + query },
//     { id: 2, title: 'Article 2', content: 'Content for article 2 related to ' + query },
//     { id: 3, title: 'Article 3', content: 'Content for article 3 related to ' + query }
//   ];
// }


async function SimilaritySearch(query: string) {
  const url = 'https://jefqrizenjvzaumvplgl.supabase.co/functions/v1/simple-search';
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImplZnFyaXplbmp2emF1bXZwbGdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjAwMzkyMTgsImV4cCI6MjAzNTYxNTIxOH0.Ixv8dBPDBAky3suPB6SfBHRAM9EHufg0OPp3xYWFusg';

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  const body = JSON.stringify({ query });

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: body
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    return data;
  } catch (error) {
    console.error('Error:', error);
    return [];
  }
}

