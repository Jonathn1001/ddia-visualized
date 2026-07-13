// @vitest-environment jsdom
import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import App from './App';

afterEach(cleanup);

test('shell renders navbar brand and the default lab page', () => {
  render(<App />);
  expect(screen.getByText('DDIA')).toBeTruthy();
  expect(screen.getByText('Visualized')).toBeTruthy();
  expect(screen.getByText('Replication Theater', { selector: 'h1' })).toBeTruthy();
});

test('sidebar navigates between labs; unbuilt labs disabled', () => {
  render(<App />);
  fireEvent.click(screen.getByText('Ping-Pong Token Ring'));
  expect(screen.getByText('Ping-Pong Token Ring', { selector: 'h1' })).toBeTruthy();
  const soonBtn = screen.getByText('LSM-Tree vs B-Tree').closest('button')!;
  expect(soonBtn.disabled).toBe(true);
});

test('hash ring lab renders from the sidebar', () => {
  render(<App />);
  fireEvent.click(screen.getByText('Consistent Hashing Ring'));
  expect(screen.getByText('Consistent Hashing Ring', { selector: 'h1' })).toBeTruthy();
  expect(screen.getByText('add node')).toBeTruthy();
});

test('rest api flow renders from the sidebar', () => {
  render(<App />);
  fireEvent.click(screen.getByText('REST API'));
  expect(screen.getByText('REST: Resources, One at a Time', { selector: 'h1' })).toBeTruthy();
  expect(screen.getByText('load profile')).toBeTruthy();
  expect(screen.getByText('Chaos Challenge — Partial page')).toBeTruthy();
});

test('grpc flow exposes the schema-version toggle', () => {
  render(<App />);
  fireEvent.click(screen.getByText('gRPC'));
  expect(screen.getByText('gRPC: Binary, Built to Evolve', { selector: 'h1' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'v2 (+field)' })).toBeTruthy();
  expect(screen.getByText('Chaos Challenge — Evolve the schema')).toBeTruthy();
});

test('kafka broker flow renders from the sidebar', () => {
  render(<App />);
  fireEvent.click(screen.getByText('Kafka Log'));
  expect(screen.getByText('Kafka: Replayable Log', { selector: 'h1' })).toBeTruthy();
  expect(screen.getByText('produce 12')).toBeTruthy();
  expect(screen.getByText('Chaos Challenge — Make it twice')).toBeTruthy();
});

test('redis broker flow renders its own challenge from the sidebar', () => {
  render(<App />);
  fireEvent.click(screen.getByText('Redis Pub/Sub'));
  expect(screen.getByText('Redis: Pub/Sub Fan-Out', { selector: 'h1' })).toBeTruthy();
  expect(screen.getByText('Chaos Challenge — Lose it forever')).toBeTruthy();
});

test('broker debrief renders from the sidebar', () => {
  render(<App />);
  const debriefs = screen.getAllByText('Debrief & Journal');
  fireEvent.click(debriefs[debriefs.length - 1]); // ch11 debrief is the last in book order
  expect(screen.getByText('Storage decides delivery', { selector: 'h1' })).toBeTruthy();
});
