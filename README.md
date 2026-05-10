# Company_Compliance_Finder
Automated compliance discovery tool that scans company domains to detect certifications like SOC 2, ISO 27001, GDPR, HIPAA, PCI, and FedRAMP. Uses Axios, Cheerio, Playwright, GraphQL, and MongoDB to crawl trust centers, security pages, and APIs for scalable compliance monitoring.
Company_Compliance_Finder is an automated compliance discovery and monitoring tool built with Node.js. It scans company domains to identify security, privacy, and compliance certifications such as SOC 2, ISO 27001, GDPR, HIPAA, CCPA, PCI, FedRAMP, CSA STAR, and more.

The application intelligently discovers trust centers, security pages, compliance portals, and embedded certification data using multiple detection techniques including:

* Direct compliance URL discovery
* Homepage trust/security link crawling
* HTML scraping with Axios + Cheerio
* Dynamic content extraction using Playwright
* GraphQL/API extraction for platforms like Drata and Vanta
* Embedded JSON parsing
* Pattern-based certification detection

The system processes companies in scalable concurrent batches, stores results in MongoDB, and supports scheduled automated runs for continuous compliance monitoring.

## Features

* Automated company compliance detection
* Trust center & security page discovery
* SOC 2 Type I / Type II detection
* ISO, GDPR, HIPAA, PCI, FedRAMP, CSA STAR support
* Drata & Vanta integration support
* Concurrent batch processing
* MongoDB integration
* Scheduled daily execution
* Local test mode for debugging
* Resilient fallback scraping architecture

## Tech Stack

* Node.js
* Axios
* Cheerio
* Playwright
* MongoDB
* GraphQL
* REST APIs

## Use Cases

* Vendor security assessment
* Compliance intelligence gathering
* Third-party risk management
* Security research automation
* Compliance monitoring pipelines
* SaaS trust center aggregation

## Workflow

1. Fetch company domains
2. Discover trust/compliance URLs
3. Crawl webpages and APIs
4. Extract certifications and compliance frameworks
5. Normalize results
6. Store findings in MongoDB
7. Run continuously in scheduled batches

## Example Certifications Detected

* SOC 2 Type II
* SOC 2 Type I
* SOC 3
* ISO 27001
* ISO 27018
* GDPR
* HIPAA
* CCPA
* PCI DSS
* FedRAMP
* CSA STAR
* HITRUST

## Scalability

The application includes:

* Concurrency control
* Batch throttling
* Retry-safe execution
* Run-lock protection
* Modular parsing architecture

Ideal for large-scale compliance discovery across thousands of company domains.

