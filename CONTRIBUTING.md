# Contributing to NexaWhats

Thank you for your interest in contributing to NexaWhats! This document provides guidelines for contributing.

## Development Setup

```bash
# Clone the repository
git clone https://github.com/Malikasadjaved/nexawhats.git
cd nexawhats

# Install dependencies
npm install

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Build
npm run build

# Lint
npm run lint

# Type check
npm run typecheck
```

## Project Structure

```
src/
  socket/       # WebSocket transport, connection state machine, circuit breaker
  signal/       # Signal Protocol encryption
  binary/       # WhatsApp binary XML codec
  proto/        # Protobuf definitions
  messages/     # Send/receive/media
  groups/       # Group operations
  store/        # Auth store interface + implementations (SQLite, Memory, File)
  queue/        # Message queue + rate limiter
  middleware/   # Middleware pipeline + built-in middleware
  types/        # TypeScript type definitions
  utils/        # Shared utilities (crypto, JID, retry, logger)
  errors/       # Typed error classes
tests/
  unit/         # Unit tests (mirror src/ structure)
  integration/  # Mock transport integration tests
  e2e/          # Live WhatsApp tests (manual only)
  fixtures/     # Recorded protocol snapshots
  helpers/      # Test utilities
```

## Pull Request Process

1. Fork the repository and create your branch from `main`
2. Write tests for any new functionality
3. Ensure all tests pass: `npm test`
4. Ensure linting passes: `npm run lint`
5. Ensure type checking passes: `npm run typecheck`
6. Update documentation if needed
7. Submit a pull request

## Coding Standards

- **TypeScript strict mode** — all code must pass strict type checking
- **Biome** — all code is formatted and linted with Biome
- **Tests required** — new features must include tests
- **No `any`** — avoid `any` types; use `unknown` or proper generics
- **Error handling** — use typed errors from `src/errors/`, never throw raw strings

## Commit Messages

Use conventional commits:

```
feat(store): add PostgreSQL auth store adapter
fix(socket): handle 515 disconnect during pairing
docs: add middleware usage examples
test(queue): add rate limiter edge case tests
chore: update dependencies
```

## Reporting Issues

- Use GitHub Issues
- Include Node.js version, OS, and NexaWhats version
- For connection issues: include the disconnect reason code
- For crashes: include the full stack trace
- **Never include auth credentials or session data in issues**

## Code of Conduct

Be respectful and constructive. We're all here to build better tools.
