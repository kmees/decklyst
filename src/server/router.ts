import { parseDeckcode, validateDeckcode } from '@/common/deckcode'
import { deckShortUrl, siteUrl } from '@/common/urls'
import * as trpc from '@trpc/server'
import { difference } from 'lodash'
import { customAlphabet } from 'nanoid'
import { Buffer } from 'node:buffer'
import { z } from 'zod'
import type { Context } from './context'

const IMAGE_VERSION = '2.1' // TODO: use git commit hash?

const alphabet = '23456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijklmnpqrstuvwxyz'
const nanoid = customAlphabet(alphabet, 3)

const generateShortid = async (ctx: Context, size = 3): Promise<string> => {
  const candidates = new Array(15).fill(0).map(() => nanoid(size))
  const taken = await ctx.prisma.deck.findMany({
    select: { shortid: true },
    where: {
      shortid: { in: candidates },
    },
  })
  const shortid = difference(
    candidates,
    taken.map((d) => d.shortid),
  )[0]

  return shortid ?? (await generateShortid(ctx, size + 1))
}

export const serverRouter = trpc
  .router<Context>()
  .query('getDeck', {
    input: z.object({
      deckcode: z.string(),
    }),
    resolve: async ({ input, ctx }) => {
      return await ctx.prisma.deck.findUnique({ where: { deckcode: input.deckcode } })
    },
  })
  .query('resolveDeck', {
    input: z.object({
      deckcodeOrShortid: z.string(),
    }),
    resolve: async ({ input: { deckcodeOrShortid }, ctx }) => {
      return await ctx.prisma.deck.findFirst({
        select: { shortid: true, deckcode: true },
        where: { OR: [{ deckcode: deckcodeOrShortid }, { shortid: deckcodeOrShortid }] },
      })
    },
  })
  .query('getDeckImage', {
    input: z.object({
      deckcode: z.string(),
    }),
    resolve: async ({ input, ctx }) => {
      let run = 0

      while (run < 10) {
        const deck = await ctx.prisma.deck.findUnique({ where: { deckcode: input.deckcode } })
        const image = deck?.imageVersion === IMAGE_VERSION ? deck?.image ?? null : null

        if (image) return image

        if (deck?.imageRendering) {
          await new Promise((resolve) => setTimeout(resolve, 500))
        } else {
          return null
        }

        run += 1
      }

      return null
    },
  })
  .mutation('ensureDeck', {
    input: z.object({
      deckcodeOrShortid: z.string(),
    }),
    resolve: async ({ input: { deckcodeOrShortid }, ctx }) => {
      const deck = await ctx.prisma.deck.findFirst({
        select: { shortid: true, deckcode: true },
        where: { OR: [{ deckcode: deckcodeOrShortid }, { shortid: deckcodeOrShortid }] },
      })

      if (deck) return deck

      const parsedDeck = validateDeckcode(deckcodeOrShortid)
        ? parseDeckcode(deckcodeOrShortid)
        : null

      if (parsedDeck === null) return null

      const shortid = await generateShortid(ctx)
      return await ctx.prisma.deck.create({
        select: { shortid: true, deckcode: true },
        data: { deckcode: parsedDeck.deckcode, shortid },
      })
    },
  })
  .mutation('renderDeckImage', {
    input: z.object({
      deckcode: z.string(),
    }),
    resolve: async ({ input, ctx }) => {
      const { shortid, deckcode } = await ctx.prisma.deck.upsert({
        select: { shortid: true, deckcode: true },
        where: { deckcode: input.deckcode },
        update: { imageRendering: true },
        create: {
          deckcode: input.deckcode,
          shortid: await generateShortid(ctx),
          imageRendering: true,
        },
      })

      try {
        const renderUrls = [`${siteUrl}/api/render/${encodeURIComponent(deckcode ?? '')}`].concat(
          process.env.USE_URLBOX_RENDER === 'true' ? getUrlboxRenderUrl(shortid) : [],
        )
        const response = await Promise.race(renderUrls.map((renderUrl) => fetch(renderUrl)))
        const blob = await response.blob()
        const image = Buffer.from(await blob.arrayBuffer())

        await ctx.prisma.deck.update({
          where: { deckcode },
          data: { deckcode, image, imageVersion: IMAGE_VERSION, imageRendering: false },
        })
        return image
      } catch (e) {
        await ctx.prisma.deck.update({
          where: { deckcode },
          data: { deckcode, imageRendering: false },
        })
      }

      return null
    },
  })

const getUrlboxRenderUrl = (shortid: string) => {
  const url = deckShortUrl(shortid) + '?snapshot=1'

  return `https://api.urlbox.io/v1/28RW9V9y8LD2ni5y/png?url=${encodeURIComponent(
    url,
  )}&selector=%23snap&wait_timeout=3000&wait_until=domloaded`
}
export type ServerRouter = typeof serverRouter
