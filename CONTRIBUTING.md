# Contributing

Thanks for your interest in contributing to PlateSpinner! Here's how to get involved.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/moridinamael/platespinner/issues) with:

- A clear title and description
- Steps to reproduce the problem
- Expected vs actual behavior
- Node.js version and OS

## Suggesting Features

Open a [GitHub Issue](https://github.com/moridinamael/platespinner/issues) with:

- A description of the feature and the problem it solves
- Any alternatives you've considered

## Development Setup

1. Fork the repository
2. Clone your fork:
   ```bash
   git clone https://github.com/YOUR_USERNAME/kanban-interface.git
   cd kanban-interface
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the dev server:
   ```bash
   npm run dev
   ```
5. Frontend runs on `http://localhost:5173`, backend on `http://localhost:3001`.

## Pull Request Guidelines

- Branch from `main`
- Describe what your changes do and why
- Run `npm test` before submitting
- Keep PRs focused — one feature or fix per PR

## Code Style

- ES modules (`import`/`export`)
- React functional components with hooks
- No TypeScript (plain JavaScript)
- Prefer simple, readable code over clever abstractions
