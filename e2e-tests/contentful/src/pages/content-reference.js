import { graphql } from "gatsby"
import * as React from "react"
import slugify from "slugify"

import Layout from "../components/layout"

import * as components from "../components/references"

function renderReferencedComponent(ref) {
  const Component = components[ref.__typename]
  if (!Component) {
    throw new Error(
      `Unable to render referenced component of type ${ref.__typename}`
    )
  }
  return <Component {...ref} />
}

const ContentReferencePage = ({ data }) => {
  const defaultEntries = data.default.nodes
  const englishEntries = data.english.nodes
  const germanEntries = data.german.nodes

  return (
    <Layout>
      <h1>Default</h1>
      {defaultEntries.map(({ sys: { id }, title, one, many, linkedFrom }) => {
        const slug = slugify(title, { strict: true, lower: true })

        let content = null
        if (many) {
          content = many.map(renderReferencedComponent)
        }

        if (one) {
          content = renderReferencedComponent(one)
        }

        return (
          <div data-cy-id={`default-${slug}`} key={id}>
            <h2>
              {title} ({id})
            </h2>
            {content}
            <h3>Linked from:</h3>
            <pre>
              <code>{JSON.stringify(linkedFrom, null, 2)}</code>
            </pre>
          </div>
        )
      })}
      <h1>English Locale</h1>
      {englishEntries.map(
        ({ sys: { id }, title, oneLocalized, manyLocalized }) => {
          const slug = slugify(title, { strict: true, lower: true })

          let content = null
          if (manyLocalized) {
            content = manyLocalized.map(renderReferencedComponent)
          }

          if (oneLocalized) {
            content = renderReferencedComponent(oneLocalized)
          }

          return (
            <div data-cy-id={`english-${slug}`} key={id}>
              <h2>{title}</h2>
              {content}
            </div>
          )
        }
      )}
      <h1>German Locale</h1>
      {germanEntries.map(
        ({ sys: { id }, title, oneLocalized, manyLocalized }) => {
          const slug = slugify(title, { strict: true, lower: true })

          let content = null
          if (manyLocalized) {
            content = manyLocalized.map(renderReferencedComponent)
          }

          if (oneLocalized) {
            content = renderReferencedComponent(oneLocalized)
          }

          return (
            <div data-cy-id={`german-${slug}`} key={id}>
              <h2>{title}</h2>
              {content}
            </div>
          )
        }
      )}
    </Layout>
  )
}

export default ContentReferencePage

export const pageQuery = graphql`
  query ContentReferenceQuery {
    default: allContentfulContentTypeContentReference(
      sort: { title: ASC }
      filter: {
        sys: { locale: { eq: "en-US" } }
        title: { glob: "!*Localized*" }
      }
    ) {
      nodes {
        title
        sys {
          id
        }
        linkedFrom {
          ContentfulContentTypeContentReference {
            sys {
              id
            }
          }
        }
        one {
          __typename
          ... on ContentfulEntry {
            sys {
              id
            }
          }
          ... on ContentfulContentTypeText {
            title
            short
          }
          ... on ContentfulContentTypeNumber {
            title
            integer
          }
          ... on ContentfulContentTypeContentReference {
            title
            one {
              ... on ContentfulContentTypeText {
                title
                short
              }
              ... on ContentfulContentTypeNumber {
                title
                integer
              }
              ... on ContentfulContentTypeContentReference {
                title
              }
            }
            many {
              ... on ContentfulContentTypeText {
                title
                short
              }
              ... on ContentfulContentTypeNumber {
                title
                integer
              }
              ... on ContentfulContentTypeContentReference {
                title
              }
            }
          }
        }
        many {
          __typename
          ... on ContentfulEntry {
            sys {
              id
            }
          }
          ... on ContentfulContentTypeText {
            title
            short
          }
          ... on ContentfulContentTypeNumber {
            title
            integer
          }
          ... on ContentfulContentTypeContentReference {
            title
            ... on ContentfulEntry {
              sys {
                id
              }
            }
            one {
              ... on ContentfulContentTypeText {
                title
                short
              }
              ... on ContentfulContentTypeNumber {
                title
                integer
              }
              ... on ContentfulContentTypeContentReference {
                title
              }
            }
            many {
              ... on ContentfulContentTypeText {
                title
                short
              }
              ... on ContentfulContentTypeNumber {
                title
                integer
              }
              ... on ContentfulContentTypeContentReference {
                title
              }
            }
          }
        }
      }
    }
    english: allContentfulContentTypeContentReference(
      sort: { title: ASC }
      filter: {
        sys: { locale: { eq: "en-US" } }
        title: { glob: "*Localized*" }
      }
    ) {
      nodes {
        title
        sys {
          id
        }
        oneLocalized {
          __typename
          ... on ContentfulContentTypeNumber {
            title
            decimal
            integer
          }
        }
        manyLocalized {
          __typename
          ... on ContentfulContentTypeNumber {
            title
            decimal
            integer
          }
          ... on ContentfulContentTypeText {
            title
            short
            longPlain {
              raw
            }
          }
        }
      }
    }
    german: allContentfulContentTypeContentReference(
      sort: { title: ASC }
      filter: {
        sys: { locale: { eq: "de-DE" } }
        title: { glob: "*Localized*" }
      }
    ) {
      nodes {
        title
        sys {
          id
        }
        oneLocalized {
          __typename
          ... on ContentfulContentTypeNumber {
            title
            decimal
            integer
          }
        }
        manyLocalized {
          __typename
          ... on ContentfulContentTypeNumber {
            title
            decimal
            integer
          }
          ... on ContentfulContentTypeText {
            title
            short
            longPlain {
              raw
            }
          }
        }
      }
    }
  }
`
