import type { Actions, Node, SourceNodesArgs } from "gatsby"
import _ from "lodash"
import { getGatsbyVersion } from "gatsby-core-utils"
import { lt, prerelease } from "semver"

import { restrictedNodeFields, conflictFieldPrefix } from "./config"
import type {
  IContentfulAsset,
  IContentfulEntry,
  IContentfulLink,
  ILocalizedField,
} from "./types/contentful"
import type {
  SyncCollection,
  Asset,
  ContentType,
  Space,
  Locale,
  LocaleCode,
  AssetFile,
  EntryWithAllLocalesAndWithoutLinkResolution,
} from "./types/contentful-js-sdk"
import type { IProcessedPluginOptions } from "./types/plugin"
import type { FieldsType } from "./types/contentful-js-sdk/query/util"

export const makeTypeName = (
  type: string,
  typePrefix = `ContentfulContentType`
): string => _.upperFirst(_.camelCase(`${typePrefix} ${type}`))

const GATSBY_VERSION_MANIFEST_V2 = `4.3.0`
const gatsbyVersion =
  (typeof getGatsbyVersion === `function` && getGatsbyVersion()) || `0.0.0`
const gatsbyVersionIsPrerelease = prerelease(gatsbyVersion)
const shouldUpgradeGatsbyVersion =
  lt(gatsbyVersion, GATSBY_VERSION_MANIFEST_V2) && !gatsbyVersionIsPrerelease

interface IContententfulLocaleFallback {
  [key: string]: LocaleCode
}

export const getLocalizedField = ({
  field,
  locale,
  localesFallback,
}: {
  field: ILocalizedField
  locale: Locale
  localesFallback: IContententfulLocaleFallback
}): unknown => {
  if (!field) {
    return null
  }
  if (!_.isUndefined(field[locale.code])) {
    return field[locale.code]
  } else if (
    !_.isUndefined(locale.code) &&
    !_.isUndefined(localesFallback[locale.code])
  ) {
    return getLocalizedField({
      field,
      locale: { ...locale, code: localesFallback[locale.code] },
      localesFallback,
    })
  } else {
    return null
  }
}
export const buildFallbackChain = (
  locales: Array<Locale>
): IContententfulLocaleFallback => {
  const localesFallback = {}
  _.each(
    locales,
    locale => (localesFallback[locale.code] = locale.fallbackCode)
  )
  return localesFallback
}
const makeGetLocalizedField =
  ({ locale, localesFallback }) =>
  (field: ILocalizedField): unknown =>
    getLocalizedField({ field, locale, localesFallback })

export const makeId = ({
  spaceId,
  id,
  currentLocale,
  defaultLocale,
  type,
}: {
  spaceId: string
  id: string
  currentLocale: string
  defaultLocale: string
  type: string
}): string => {
  const normalizedType = type.startsWith(`Deleted`)
    ? type.substring(`Deleted`.length)
    : type
  return currentLocale === defaultLocale
    ? `${spaceId}___${id}___${normalizedType}`
    : `${spaceId}___${id}___${normalizedType}___${currentLocale}`
}

const makeMakeId =
  ({ currentLocale, defaultLocale, createNodeId }) =>
  (spaceId, id, type): string =>
    createNodeId(makeId({ spaceId, id, currentLocale, defaultLocale, type }))

// Generates an unique id per space for reference resolving
// TODO: space id is actually not factored in here!
export const createRefId = (
  node:
    | EntryWithAllLocalesAndWithoutLinkResolution<FieldsType, string>
    | IContentfulEntry
    | Asset
): string => `${node.sys.id}___${node.sys.type}`

export const createLinkRefId = (link: IContentfulLink): string =>
  `${link.sys.id}___${link.sys.linkType}`

export const buildEntryList = ({
  contentTypeItems,
  currentSyncData,
}: {
  contentTypeItems: Array<ContentType>
  currentSyncData: SyncCollection
}): Array<
  Array<EntryWithAllLocalesAndWithoutLinkResolution<FieldsType, string>>
> => {
  // Create buckets for each type sys.id that we care about (we will always want an array for each, even if its empty)
  const map: Map<
    string,
    Array<EntryWithAllLocalesAndWithoutLinkResolution<FieldsType, string>>
  > = new Map(contentTypeItems.map(contentType => [contentType.sys.id, []]))
  // Now fill the buckets. Ignore entries for which there exists no bucket. (This happens when filterContentType is used)
  currentSyncData.entries.map(entry => {
    const arr = map.get(entry.sys.contentType.sys.id)
    if (arr) {
      arr.push(entry)
    }
  })
  // Order is relevant, must map 1:1 to contentTypeItems array
  return contentTypeItems.map(contentType => map.get(contentType.sys.id) || [])
}

export const buildResolvableSet = ({
  entryList,
  existingNodes = [],
  assets = [],
}: {
  entryList: Array<
    Array<EntryWithAllLocalesAndWithoutLinkResolution<FieldsType, string>>
  >
  existingNodes: Array<IContentfulEntry>
  assets: Array<Asset>
}): Set<string> => {
  const resolvable: Set<string> = new Set()
  existingNodes.forEach(node => {
    if (node.internal.owner === `gatsby-source-contentful` && node?.sys?.id) {
      // We need to add only root level resolvable (assets and entries)
      // Derived nodes (markdown or JSON) will be recreated if needed.
      resolvable.add(createRefId(node))
    }
  })

  entryList.forEach(entries => {
    entries.forEach(entry => resolvable.add(createRefId(entry)))
  })

  assets.forEach(assetItem => resolvable.add(createRefId(assetItem)))

  return resolvable
}

interface IForeignReference {
  name: string
  id: string
  spaceId: string
  type: string // Could be based on constances?
}

interface IForeignReferenceMap {
  [key: string]: Array<IForeignReference>
}

interface IForeignReferenceMapState {
  links: Array<string>
  backLinks: IForeignReferenceMap
}

function cleanupReferencesFromEntry(
  foreignReferenceMapState: IForeignReferenceMapState,
  entry: EntryWithAllLocalesAndWithoutLinkResolution<FieldsType, string>
): void {
  const { links, backLinks } = foreignReferenceMapState
  const entryId = entry.sys.id

  const entryLinks = links[entryId]
  if (entryLinks) {
    entryLinks.forEach(link => {
      const backLinksForLink = backLinks[link]
      if (backLinksForLink) {
        const newBackLinks = backLinksForLink.filter(({ id }) => id !== entryId)
        if (newBackLinks.length > 0) {
          backLinks[link] = newBackLinks
        } else {
          delete backLinks[link]
        }
      }
    })
  }

  delete links[entryId]
}

export const buildForeignReferenceMap = ({
  contentTypeItems,
  entryList,
  resolvable,
  defaultLocale,
  space,
  useNameForId,
  previousForeignReferenceMapState,
  deletedEntries,
}: {
  contentTypeItems: Array<ContentType>
  entryList: Array<
    Array<EntryWithAllLocalesAndWithoutLinkResolution<FieldsType, string>>
  >
  resolvable: Set<string>
  defaultLocale: string
  space: Space
  useNameForId: boolean
  previousForeignReferenceMapState?: IForeignReferenceMapState
  deletedEntries: Array<
    EntryWithAllLocalesAndWithoutLinkResolution<FieldsType, string>
  >
}): IForeignReferenceMapState => {
  const foreignReferenceMapState: IForeignReferenceMapState =
    previousForeignReferenceMapState || {
      links: [],
      backLinks: {},
    }

  const { links, backLinks } = foreignReferenceMapState

  for (const deletedEntry of deletedEntries) {
    // remove stored entries from entry that is being deleted
    cleanupReferencesFromEntry(foreignReferenceMapState, deletedEntry)
  }

  contentTypeItems.forEach((contentTypeItem, i) => {
    // Establish identifier for content type
    //  Use `name` if specified, otherwise, use internal id (usually a natural-language constant,
    //  but sometimes a base62 uuid generated by Contentful, hence the option)
    let contentTypeItemId
    if (useNameForId) {
      contentTypeItemId = contentTypeItem.name.toLowerCase()
    } else {
      contentTypeItemId = contentTypeItem.sys.id.toLowerCase()
    }

    entryList[i].forEach(entryItem => {
      // clear links added in previous runs for given entry, as we will recreate them anyway
      cleanupReferencesFromEntry(foreignReferenceMapState, entryItem)

      const entryItemFields = entryItem.fields
      Object.keys(entryItemFields).forEach(entryItemFieldKey => {
        if (entryItemFields[entryItemFieldKey]) {
          const entryItemFieldValue =
            entryItemFields[entryItemFieldKey][defaultLocale]
          // If this is an array of single reference object
          // add to the reference map, otherwise ignore.
          if (Array.isArray(entryItemFieldValue)) {
            if (
              entryItemFieldValue[0] &&
              entryItemFieldValue[0].sys &&
              entryItemFieldValue[0].sys.type &&
              entryItemFieldValue[0].sys.id
            ) {
              entryItemFieldValue.forEach(v => {
                const key = createLinkRefId(v)
                // Don't create link to an unresolvable field.
                if (!resolvable.has(key)) {
                  return
                }

                if (!backLinks[key]) {
                  backLinks[key] = []
                }
                backLinks[key].push({
                  name: contentTypeItemId,
                  id: entryItem.sys.id,
                  spaceId: space.sys.id,
                  type: entryItem.sys.type,
                })

                if (!links[entryItem.sys.id]) {
                  links[entryItem.sys.id] = []
                }

                links[entryItem.sys.id].push(key)
              })
            }
          } else if (
            entryItemFieldValue?.sys?.type &&
            entryItemFieldValue.sys.id
          ) {
            const key = createLinkRefId(entryItemFieldValue)
            // Don't create link to an unresolvable field.
            if (!resolvable.has(key)) {
              return
            }

            if (!backLinks[key]) {
              backLinks[key] = []
            }
            backLinks[key].push({
              name: contentTypeItemId,
              id: entryItem.sys.id,
              spaceId: space.sys.id,
              type: entryItem.sys.type,
            })

            if (!links[entryItem.sys.id]) {
              links[entryItem.sys.id] = []
            }

            links[entryItem.sys.id].push(key)
          }
        }
      })
    })
  })

  return foreignReferenceMapState
}

function prepareTextNode(
  id: string,
  node: IContentfulEntry,
  _key: string,
  text: unknown
): Node {
  const str = _.isString(text) ? text : ``
  const textNode: Node = {
    id,
    parent: node.id,
    raw: str,
    internal: {
      type: `ContentfulText`,
      mediaType: `text/markdown`,
      content: str,
      // entryItem.sys.publishedAt is source of truth from contentful
      contentDigest: node.sys.publishedAt,
    },
    children: [],
  }

  return textNode
}

let numberOfContentSyncDebugLogs = 0
const maxContentSyncDebugLogTimes = 50

let warnOnceForNoSupport = false
let warnOnceToUpgradeGatsby = false

/**
 * This fn creates node manifests which are used for Gatsby Cloud Previews via the Content Sync API/feature.
 * Content Sync routes a user from Contentful to a page created from the entry data they're interested in previewing.
 */

function contentfulCreateNodeManifest({
  pluginConfig,
  entryItem,
  entryNode,
  space,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  unstable_createNodeManifest,
}: {
  pluginConfig: IProcessedPluginOptions
  entryItem: EntryWithAllLocalesAndWithoutLinkResolution<FieldsType, string>
  entryNode: IContentfulEntry
  space: Space
  unstable_createNodeManifest: SourceNodesArgs["unstable_createNodeManifest"]
}): void {
  const isPreview = pluginConfig.get(`host`) === `preview.contentful.com`

  const createNodeManifestIsSupported =
    typeof unstable_createNodeManifest === `function`

  const shouldCreateNodeManifest = isPreview && createNodeManifestIsSupported

  const updatedAt = entryItem.sys.updatedAt

  const manifestId = `${space.sys.id}-${entryItem.sys.id}-${updatedAt}`

  if (
    process.env.CONTENTFUL_DEBUG_NODE_MANIFEST === `true` &&
    numberOfContentSyncDebugLogs <= maxContentSyncDebugLogTimes
  ) {
    numberOfContentSyncDebugLogs++

    console.info(
      JSON.stringify({
        isPreview,
        createNodeManifestIsSupported,
        shouldCreateNodeManifest,
        manifestId,
        entryItemSysUpdatedAt: updatedAt,
      })
    )
  }

  if (shouldCreateNodeManifest) {
    if (shouldUpgradeGatsbyVersion && !warnOnceToUpgradeGatsby) {
      console.warn(
        `Your site is doing more work than it needs to for Preview, upgrade to Gatsby ^${GATSBY_VERSION_MANIFEST_V2} for better performance`
      )
      warnOnceToUpgradeGatsby = true
    }

    unstable_createNodeManifest({
      manifestId,
      node: entryNode,
      updatedAtUTC: updatedAt,
    })
  } else if (
    isPreview &&
    !createNodeManifestIsSupported &&
    !warnOnceForNoSupport
  ) {
    console.warn(
      `Contentful: Your version of Gatsby core doesn't support Content Sync (via the unstable_createNodeManifest action). Please upgrade to the latest version to use Content Sync in your site.`
    )
    warnOnceForNoSupport = true
  }
}

interface ICreateNodesForContentTypeArgs extends Actions, SourceNodesArgs {
  contentTypeItem: ContentType
  entries: Array<
    EntryWithAllLocalesAndWithoutLinkResolution<FieldsType, string>
  >
  resolvable: Set<string>
  foreignReferenceMap: IForeignReferenceMap
  defaultLocale: string
  locales: Array<Locale>
  space: Space
  useNameForId: boolean
  pluginConfig: IProcessedPluginOptions
}

export const createNodesForContentType = ({
  contentTypeItem,
  entries,
  // eslint-disable-next-line @typescript-eslint/naming-convention
  unstable_createNodeManifest,
  createNode,
  createNodeId,
  getNode,
  resolvable,
  foreignReferenceMap,
  defaultLocale,
  locales,
  space,
  useNameForId,
  pluginConfig,
}: ICreateNodesForContentTypeArgs): Array<void | Promise<void>> => {
  // Establish identifier for content type
  //  Use `name` if specified, otherwise, use internal id (usually a natural-language constant,
  //  but sometimes a base62 uuid generated by Contentful, hence the option)
  let contentTypeItemId
  if (useNameForId) {
    contentTypeItemId = contentTypeItem.name
  } else {
    contentTypeItemId = contentTypeItem.sys.id
  }

  const createNodePromises: Array<void | Promise<void>> = []

  // Create a node for the content type
  const contentTypeNode = {
    id: createNodeId(contentTypeItemId),
    name: contentTypeItem.name,
    displayField: contentTypeItem.displayField,
    description: contentTypeItem.description,
    internal: {
      type: `ContentfulContentType`,
      contentDigest: contentTypeItem.sys.updatedAt,
    },
    // https://www.contentful.com/developers/docs/references/content-delivery-api/#/introduction/common-resource-attributes
    // https://www.contentful.com/developers/docs/references/graphql/#/reference/schema-generation/sys-field
    sys: {
      type: contentTypeItem.sys.type,
      id: contentTypeItem.sys.id,
      spaceId: contentTypeItem.sys.space.sys.id,
      environmentId: contentTypeItem.sys.environment.sys.id,
      firstPublishedAt: contentTypeItem.sys.createdAt,
      publishedAt: contentTypeItem.sys.updatedAt,
      publishedVersion: contentTypeItem.sys.revision,
    },
  }

  createNodePromises.push(createNode(contentTypeNode))

  locales.forEach(locale => {
    const localesFallback = buildFallbackChain(locales)
    const mId = makeMakeId({
      currentLocale: locale.code,
      defaultLocale,
      createNodeId,
    })
    const getField = makeGetLocalizedField({
      locale,
      localesFallback,
    })

    // Warn about any field conflicts
    const conflictFields: Array<string> = []
    contentTypeItem.fields.forEach(contentTypeItemField => {
      const fieldName = contentTypeItemField.id
      if (restrictedNodeFields.includes(fieldName)) {
        console.log(
          `Restricted field found for ContentType ${contentTypeItemId} and field ${fieldName}. Prefixing with ${conflictFieldPrefix}.`
        )
        conflictFields.push(fieldName)
      }
    })

    const childrenNodes: Array<Node> = []

    // First create nodes for each of the entries of that content type
    const entryNodes = entries.map(entryItem => {
      const entryNodeId = mId(
        space.sys.id,
        entryItem.sys.id,
        entryItem.sys.type
      )

      const existingNode = getNode(entryNodeId)
      if (existingNode?.updatedAt === entryItem.sys.updatedAt) {
        // The Contentful model has `.sys.updatedAt` leading for an entry. If the updatedAt value
        // of an entry did not change, then we can trust that none of its children were changed either.
        return null
      }

      // Get localized fields.
      const entryItemFields = _.mapValues(entryItem.fields, (v, k) => {
        const fieldProps = contentTypeItem.fields.find(field => field.id === k)

        if (!fieldProps) {
          throw new Error(`Unable to translate field ${k}`)
        }

        const localizedField = fieldProps.localized
          ? getField(v)
          : v[defaultLocale]

        return localizedField
      })

      // Prefix any conflicting fields
      // https://github.com/gatsbyjs/gatsby/pull/1084#pullrequestreview-41662888
      conflictFields.forEach(conflictField => {
        entryItemFields[`${conflictFieldPrefix}${conflictField}`] =
          entryItemFields[conflictField]
        delete entryItemFields[conflictField]
      })

      // Add linkages to other nodes based on foreign references
      Object.keys(entryItemFields).forEach(entryItemFieldKey => {
        if (entryItemFields[entryItemFieldKey]) {
          const entryItemFieldValue = entryItemFields[entryItemFieldKey]
          if (Array.isArray(entryItemFieldValue)) {
            if (entryItemFieldValue[0]?.sys?.type === `Link`) {
              // Check if there are any values in entryItemFieldValue to prevent
              // creating an empty node field in case when original key field value
              // is empty due to links to missing entities
              const resolvableEntryItemFieldValue = entryItemFieldValue
                .filter(v => resolvable.has(createLinkRefId(v)))
                .map(function (v) {
                  return mId(
                    space.sys.id,
                    v.sys.id,
                    v.sys.linkType || v.sys.type
                  )
                })
              if (resolvableEntryItemFieldValue.length !== 0) {
                entryItemFields[entryItemFieldKey] =
                  resolvableEntryItemFieldValue
              }
            }
          } else if (entryItemFieldValue?.sys?.type === `Link`) {
            if (resolvable.has(createLinkRefId(entryItemFieldValue))) {
              entryItemFields[entryItemFieldKey] = mId(
                space.sys.id,
                entryItemFieldValue.sys.id,
                entryItemFieldValue.sys.linkType || entryItemFieldValue.sys.type
              )
            }
          }
        }
      })

      // Add reverse linkages if there are any for this node
      const foreignReferences = foreignReferenceMap[createRefId(entryItem)]
      if (foreignReferences) {
        foreignReferences.forEach(foreignReference => {
          const existingReference = entryItemFields[foreignReference.name]
          if (existingReference) {
            // If the existing reference is a string, we're dealing with a
            // many-to-one reference which has already been recorded, so we can
            // skip it. However, if it is an array, add it:
            if (Array.isArray(existingReference)) {
              entryItemFields[foreignReference.name].push(
                mId(
                  foreignReference.spaceId,
                  foreignReference.id,
                  foreignReference.type
                )
              )
            }
          } else {
            // If there is one foreign reference, there can be many.
            // Best to be safe and put it in an array to start with.
            entryItemFields[foreignReference.name] = [
              mId(
                foreignReference.spaceId,
                foreignReference.id,
                foreignReference.type
              ),
            ]
          }
        })
      }

      // Create actual entry node
      let entryNode: IContentfulEntry = {
        id: entryNodeId,
        parent: contentTypeItemId,
        children: [],
        internal: {
          type: makeTypeName(contentTypeItemId),
          // The content of an entry is guaranteed to be updated if and only if the .sys.updatedAt field changed
          contentDigest: entryItem.sys.updatedAt,
        },
        // https://www.contentful.com/developers/docs/references/content-delivery-api/#/introduction/common-resource-attributes
        // https://www.contentful.com/developers/docs/references/graphql/#/reference/schema-generation/sys-field
        sys: {
          type: entryItem.sys.type,
          id: entryItem.sys.id,
          locale: locale.code,
          spaceId: entryItem.sys.space.sys.id,
          environmentId: entryItem.sys.environment.sys.id,
          contentType: createNodeId(contentTypeItemId),
          firstPublishedAt: entryItem.sys.createdAt,
          publishedAt: entryItem.sys.updatedAt,
          publishedVersion: entryItem.sys.revision,
        },
        metadata: {
          tags: entryItem.metadata.tags.map(tag =>
            createNodeId(`ContentfulTag__${space.sys.id}__${tag.sys.id}`)
          ),
        },
      }

      contentfulCreateNodeManifest({
        pluginConfig,
        entryItem,
        entryNode,
        space,
        // eslint-disable-next-line @typescript-eslint/naming-convention
        unstable_createNodeManifest,
      })

      // Replace text fields with text nodes so we can process their markdown
      // into HTML.
      Object.keys(entryItemFields).forEach(entryItemFieldKey => {
        // TODO:: how expensive is this?
        const field = contentTypeItem.fields.find(
          f =>
            (restrictedNodeFields.includes(f.id)
              ? `${conflictFieldPrefix}${f.id}`
              : f.id) === entryItemFieldKey
        )
        if (field?.type === `Text`) {
          const textNodeId = createNodeId(
            `${entryNodeId}${entryItemFieldKey}TextNode`
          )

          // The Contentful model has `.sys.updatedAt` leading for an entry. If the updatedAt value
          // of an entry did not change, then we can trust that none of its children were changed either.
          // (That's why child nodes use the updatedAt of the parent node as their digest, too)
          const existingNode = getNode(textNodeId)
          if (existingNode?.updatedAt !== entryItem.sys.updatedAt) {
            const textNode = prepareTextNode(
              textNodeId,
              entryNode,
              entryItemFieldKey,
              entryItemFields[entryItemFieldKey]
            )

            childrenNodes.push(textNode)
          }

          entryItemFields[entryItemFieldKey] = textNodeId
        }
      })

      entryNode = {
        ...entryItemFields,
        ...entryNode,
      }
      return entryNode
    })

    entryNodes.forEach(entryNode => {
      if (!entryNode) {
        return
      }
      createNodePromises.push(createNode(entryNode))
    })
    childrenNodes.forEach(entryNode => {
      createNodePromises.push(createNode(entryNode))
    })
  })

  return createNodePromises
}

export const createAssetNodes = ({
  assetItem,
  createNode,
  createNodeId,
  defaultLocale,
  locales,
  space,
}: {
  assetItem
  createNode
  createNodeId
  defaultLocale
  locales: Array<Locale>
  space: Space
}): Array<Promise<IContentfulAsset>> => {
  const createNodePromises: Array<Promise<IContentfulAsset>> = []
  locales.forEach(locale => {
    const localesFallback = buildFallbackChain(locales)
    const mId = makeMakeId({
      currentLocale: locale.code,
      defaultLocale,
      createNodeId,
    })
    const getField = makeGetLocalizedField({
      locale,
      localesFallback,
    })

    const fileRes = getField(assetItem.fields?.file)

    if (!fileRes) {
      return
    }

    const file = fileRes as unknown as AssetFile

    // Skip empty and unprocessed assets in Preview API
    if (!file || !file.url || !file.contentType || !file.fileName) {
      return
    }

    const assetNode = {
      id: mId(space.sys.id, assetItem.sys.id, assetItem.sys.type),
      parent: null,
      children: [],
      file,
      internal: {
        type: `ContentfulAsset`,
        // The content of an asset is guaranteed to be updated if and only if the .sys.updatedAt field changed
        contentDigest: assetItem.sys.updatedAt,
      },
      // https://www.contentful.com/developers/docs/references/content-delivery-api/#/introduction/common-resource-attributes
      // https://www.contentful.com/developers/docs/references/graphql/#/reference/schema-generation/sys-field
      sys: {
        type: assetItem.sys.type,
        id: assetItem.sys.id,
        locale: locale.code,
        spaceId: assetItem.sys.space.sys.id,
        environmentId: assetItem.sys.environment.sys.id,
        firstPublishedAt: assetItem.sys.createdAt,
        publishedAt: assetItem.sys.updatedAt,
        publishedVersion: assetItem.sys.revision,
      },
      placeholderUrl: `https:${file.url}?w=%width%&h=%height%`,
      url: `https:${file.url}`,
      // These fields are optional for edge cases in the Preview API and Contentfuls asset processing
      width: file.details?.image?.width ?? null,
      height: file.details?.image?.height ?? null,
      size: file.details?.size ?? null,
      metadata: {
        tags: assetItem.metadata.tags.map(tag =>
          createNodeId(`ContentfulTag__${space.sys.id}__${tag.sys.id}`)
        ),
      },
      title: assetItem.fields.title ? getField(assetItem.fields.title) : ``,
      description: assetItem.fields.description
        ? getField(assetItem.fields.description)
        : ``,
      // Satisfy the Gatsby ImageCDN feature
      mimeType: file.contentType,
      filename: file.fileName,
    }

    // if the node hasn't changed, createNode may return `undefined` instead of a Promise on some versions of Gatsby
    const maybePromise = createNode(assetNode)

    createNodePromises.push(
      maybePromise?.then ? maybePromise.then(() => assetNode) : assetNode
    )
  })

  return createNodePromises
}
