import 'server-only'
import OpenAI from 'openai'
import Markdown from 'react-markdown'

import {
  createAI,
  createStreamableUI,
  getMutableAIState,
  getAIState,
  streamUI,
  createStreamableValue
} from 'ai/rsc'
import { openai } from '@ai-sdk/openai'
import {
  BotMessage,
  SpinnerMessage,
  UserMessage
} from '@/components/stocks/message'
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
    model: openai('ft:gpt-4o-mini-2024-07-18:personal::9u8Ap51f'),
    initial: <SpinnerMessage />,
    system: `\
     You are a support article writer for a cloud communications company called RingCentral.
    You and the user work together to create support articles in the RingCentral tone and style.
    If the user requests searching similar KB/Support article, call \`similarity_search\` to perform nearest neighbor search on the vector database of support articles.
    If the user requests to update a KB/Support article and they provide a string of text, call \`update_kb_article\` to update the article. If the user asks to update a KB/Support article and they do not provide a string, ask them to first provide the content to be updated/revised.


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
          query: z
            .string()
            .describe('The query string to search for similar articles.')
        }),
        generate: async function* ({ query }) {
          const toolCallId = nanoid()

          // Function to perform similarity search based on the query
          const similarArticles = await SimilaritySearch(query)

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
          })
          console.log('similarArticles', similarArticles)

          return (
            <div>
              {/* {similarArticles} */}
              <ArticleList articles={similarArticles} />
            </div>
          )
        }
      },
      updateKBArticle: {
        description: 'Update a knowledge base article with new content.',
        parameters: z.object({
          content: z
            .string()
            .describe('The existing article or content to update.')
        }),
        generate: async function* ({ content }) {
          const toolCallId = nanoid()
          // Function to update the knowledge base article
          const updatedArticle = await updateKBArticle(content)

          // Update AI state with tool results
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
                    toolName: 'updateKBArticle',
                    toolCallId,
                    args: { content }
                  }
                ]
              },
              {
                id: nanoid(),
                role: 'tool',
                content: [
                  {
                    type: 'tool-result',
                    toolName: 'updateKBArticle',
                    toolCallId,
                    result: updatedArticle
                  }
                ]
              }
            ]
          })

          return (
            <div>
              <Markdown>{String(updatedArticle)}</Markdown>
            </div>
          )
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

async function SimilaritySearch(query: string) {
  const url =
    'https://jefqrizenjvzaumvplgl.supabase.co/functions/v1/simple-search'
  const token =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImplZnFyaXplbmp2emF1bXZwbGdsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3MjAwMzkyMTgsImV4cCI6MjAzNTYxNTIxOH0.Ixv8dBPDBAky3suPB6SfBHRAM9EHufg0OPp3xYWFusg'

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  }

  const body = JSON.stringify({ query })

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: body
    })

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`)
    }

    const data = await response.json()
    return data
  } catch (error) {
    console.error('Error:', error)
    return []
  }
}

type Article = {
  id: number
  title: string
  content: string
}

type ArticleListProps = {
  articles: Article[]
}

function ArticleList({ articles }: ArticleListProps) {
  return (
    <div>
      {articles.map(article => {
        // Transform the title
        const formattedTitle = article.title
          .replace(/^\d+/, '') // Remove the ID at the beginning
          .replace(/\.md$/, '') // Remove the '.md' extension at the end
          .replace(/_/g, ' ') // Replace underscores with spaces

        console.log(formattedTitle) // Log the transformed title

        return (
          <div key={article.id}>
            <h2>{formattedTitle}</h2>
            <p>{article.content}</p>
          </div>
        )
      })}
    </div>
  )
}

async function updateKBArticle(query) {
  const instructions = `# Allowing attendees to speak during a RingCentral Webinar

**Last Updated: May 01, 2024**

As the host or cohost of a RingCentral Webinar, you can invite attendees to speak, turn on the feature that allows attendees to request to speak, and approve or deny attendee requests. If you’re a webinar attendee and the host has allowed requests, you can request to speak.

# Host and Cohost

## Inviting and allowing Webinar attendees to speak on the RingCentral desktop and web app

As the host or cohost of a RingCentral Webinar, you can allow attendees to request to speak and invite specific attendees to speak. You can allow and invite guest speakers during a Webinar in the RingCentral desktop app for Windows or Mac, or on desktop browsers Google Chrome or Microsoft Edge.

**Note**: This feature is not available for the Safari desktop app, any mobile browsers, or RingCentral Rooms systems.

### Inviting webinar attendees to speak on the RingCentral desktop and web app

1. During your webinar, click **Participants** in the bottom menu bar.
2. In the **Attendees** list, click **Invite to speak** to the right of the person you’d like to invite to speak.

The attendee will receive a notification that you’ve invited them to speak live. If they accept the invitation, the attendee will receive the Guest speaker role.

### Allowing webinar attendee requests to speak on the RingCentral desktop and web app

1. After your webinar has gone live, click **Participants** in the bottom menu bar.
2. In the **Participants** window, click **Attendees**.
3. Click the **Allow requests to speak** toggle. Attendees can now send you speaking requests, which you can approve or decline.

# Approving and declining webinar attendee requests to speak on the RingCentral desktop and web app

1. To manage requests to speak live, click **Participants** in the bottom menu bar.
2. Click **Attendees** to view a list of speaking requests.
   - If there are multiple requests and you’d like to deny them all, click **Decline all** at the top right.
   - To decline any request, click the **X** to the right of that request.
   - To accept any request, click **Accept** to the right of that request.

## Managing webinar guest speaking permissions in the RingCentral desktop and web app

Webinar hosts and cohosts can remove guest speakers from the webinar, turn guest speakers’ cameras and microphones on or off, and demote guest speakers to nonspeaking attendees.

1. During your webinar, click **Participants** in the bottom menu bar.
2. In the **Attendees** list under **Guest Speakers**, hover over the name of the participant you want to manage.
   - Click the **X** at the right to demote the guest speaker to a nonspeaking attendee. You can also click **Demote all** next to **Guest Speakers** to demote all guest speakers to nonspeaking attendees.
   - **Microphone icon**: If the guest speaker is muted, click to ask them to turn on their microphone. If the guest speaker is unmuted, click to mute their microphone.
   - **Camera icon**: If the guest speaker is not on video, click to ask them to turn on their camera. If the guest speaker is on video, click to turn off the camera.
   - Click the three-dot **More** icon, then click **Hangup** to remove the guest speaker from the webinar. Doing so will also remove them as an attendee.

# Inviting and allowing Webinar attendees to speak on the RingCentral mobile app

### Inviting webinar attendees to speak in the RingCentral mobile app

1. During your webinar, tap **Participants** in the bottom menu bar.
2. In the **Attendees** list, tap the three-dot **More** icon to the right of the person you’d like to invite to speak and **Invite to speak**.

The attendee will receive a notification that you’ve invited them to speak live. If they accept the invitation, the attendee will receive the **Guest speaker** role.

### Allowing webinar attendee requests to speak in the RingCentral mobile app

1. After your webinar has gone live, tap **Participants** in the bottom menu bar.
2. In the **Participants** window, tap **Attendees**.
3. Tap the **Allow requests to speak** toggle. Attendees can now send you speaking requests, which you can accept or decline.

# Accepting and declining webinar attendee requests to speak in the RingCentral mobile app

1. To manage requests to speak live, tap **Participants** in the bottom menu bar.
2. Tap **Attendees** to view a list of speaking requests.
   - If there are multiple requests and you’d like to deny them all, tap **Decline all** at the top right.
   - To decline any request, tap the **Decline** under that request.
   - To accept any request, tap **Accept** under that request.

# Managing webinar guest speaking permissions in the RingCentral mobile app

Webinar hosts and cohosts can remove guest speakers from the webinar, turn guest speakers’ cameras and microphones on or off, and demote guest speakers to nonspeaking attendees.

1. During your webinar, tap **Participants** in the bottom menu bar.
2. In the **Attendees** list under **Guest Speakers**, you can manage each guest speaker’s permissions:
   - Tap the **Demote all** at the right to demote all guest speakers to nonspeaking attendees.
   - **Microphone icon**: If the guest speaker is muted, tap to ask them to turn on their microphone. If the guest speaker is unmuted, tap to mute their microphone.
   - **Camera icon**: If the guest speaker is not on video, tap to ask them to turn on their camera. If the guest speaker is on video, tap to turn off the camera.
   - Tap the three-dot **More** icon, then click **Remove from meeting** to remove the guest speaker from the webinar. Doing so will also remove them as an attendee.
   - Tap **Demote** under an individual speaker to demote them to a nonspeaking attendee.

# Attendee

# Requesting to speak during a Webinar on the RingCentral desktop and web app

If the webinar host has allowed live speaking requests from attendees, you can request to speak.

1. After the webinar begins, click **Speak Live** in the bottom menu bar. Click **Request** to send a speaking request to the webinar host.
2. If the host accepts your request, a notification will appear in the webinar window. Click Continue (a) to start setting up your microphone and camera, or click Cancel (b) to withdraw your request.
3. Use the dropdowns (a) to choose your microphone, speaker, and camera sources, then click Join as speaker (b) to join the webinar.
4. When you enter the webinar as a guest speaker, your microphone and camera will be off. Click Got it (a) and Unmute (b) when you’re ready to begin speaking. Click Start Video (c) to appear on camera.
5. When you’re done speaking, the host will return you to viewing mode as a regular, nonspeaking attendee. Click Got it (a).
- If you’d like to speak again, click Speak live (b) to send a new request, then repeat the process.
- 
# Accepting an invitation to speak during a Webinar on the RingCentral desktop and web app

If a webinar host invites you to speak, a notification will pop up in your webinar window.

1. Click **Accept** to start setting up your microphone and camera, or **Decline** to decline the request and remain a nonspeaking attendee.
   
2. Use the dropdowns to choose your microphone, speaker, and camera sources, then click **Join as speaker** to join the webinar.

3. When you enter the webinar as a guest speaker, your microphone and camera will be off. Click **Got it** and **Unmute** when you’re ready to begin speaking. Click **Start Video** to appear on camera.
4. When you’re done speaking, the host will return you to viewing mode as a regular, nonspeaking attendee. Click **Got it**.
   - If you’d like to speak again, click **Speak live** to send a new request, then repeat the process.

# Requesting to speak  during a Webinar on the RingCentral mobile app

If the webinar host has allowed live speaking requests from attendees, you can request to speak.

1. After the webinar begins, tap **Speak Live** in the bottom menu bar and **Request** to send a speaking request to the webinar host. You can tap **Decline** to cancel sending the request.
2. If the host accepts your request, tap **Continue** in the popup or tap **Cancel** to withdraw your request.
3. Tap Got it (a) when you’re ready, then tap Unmute (b) to begin speaking, and tap Start Video (c) if you want to appear on the video.

# Accepting an invitation to speak during a Webinar on the RingCentral mobile app

If a webinar host invites you to speak, a notification will pop up in your webinar window.
1. Tap Accept to speak live or Decline to decline the request and remain a nonspeaking attendee.
2. Once you accept, tap Got it (a) in the popup, then tap Unmute (b) to begin speaking, and tap Start Video (c) if you want to appear on the video.
3. When you’re done speaking, the host will return you to viewing mode as a regular, nonspeaking attendee. Tap Got it (a).
- If you’d like to speak again, tap Speak live (b) to send a new request, then repeat the process.`

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  })

  console.log('starting completion')

  const completion = await openai.chat.completions.create({
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      {
        role: 'user',
        content: `The following is a good example of an up-to-date KB article. Please revise/edit the user's input to have a similar tone and style to the following: ${instructions}. Here is the user's input: ${query}`
      }
    ],
    model: 'ft:gpt-4o-mini-2024-07-18:personal::9u8Ap51f'
  })

  console.log('completion result:', completion.choices[0].message.content)
  return completion.choices[0].message.content
}
