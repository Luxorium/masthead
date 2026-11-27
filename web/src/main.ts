import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import 'highlight.js/styles/github-dark.min.css';

mount(App, { target: document.getElementById('app')! });
