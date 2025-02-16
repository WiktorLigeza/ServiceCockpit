const socket = io();
const servicesContainer = document.getElementById('services-container');
const searchInput = document.getElementById('searchInput');
let selectedService = null;
let favorites = new Set(JSON.parse(localStorage.getItem('favorites') || '[]'));
const servicesSearchInput = document.getElementById('servicesSearchInput');
const favoritesSearchInput = document.getElementById('favoritesSearchInput');
let isLoading = true;

function toggleFavorite(event, serviceName) {
    event.stopPropagation();
    if (favorites.has(serviceName)) {
        favorites.delete(serviceName);
    } else {
        favorites.add(serviceName);
    }
    localStorage.setItem('favorites', JSON.stringify([...favorites]));
    updateServices(lastServicesData);  // We'll store the last data globally
}

function createServiceCard(service, container = 'all') {
    const isFavorite = favorites.has(service.name);
    if (container === 'favorites' && !isFavorite) return '';
    
    return `
        <div class="service-card ${service.name === selectedService ? 'selected-service' : ''}" 
             data-service-name="${service.name}">
            <div class="card">
                <button class="star-btn" onclick="toggleFavorite(event, '${service.name}')" title="${isFavorite ? 'Remove from favorites' : 'Add to favorites'}">
                    <i class="${isFavorite ? 'fas' : 'far'} fa-star"></i>
                </button>
                <div class="card-body" onclick="selectService('${service.name}')">
                    <h5 class="card-title">
                        <span class="status-dot ${service.active ? 'active' : 'inactive'}" title="Active Status"></span>
                        <span class="status-dot ${service.enabled ? 'active' : 'inactive'}" title="Enabled Status"></span>
                        ${service.name}
                    </h5>
                    <div class="btn-group w-100">
                        <button class="btn btn-sm ${service.enabled ? 'btn-power active' : 'btn-power'}"
                                onclick="controlService('${service.name}', '${service.enabled ? 'disable' : 'enable'}')" title="${service.enabled ? 'Disable' : 'Enable'} Service">
                            <i class="fas fa-power-off"></i>
                        </button>
                        <button class="btn btn-sm ${service.active ? 'btn-danger' : 'btn-success'}"
                                onclick="controlService('${service.name}', '${service.active ? 'stop' : 'start'}')" title="${service.active ? 'Stop' : 'Start'} Service">
                            <i class="fas ${service.active ? 'fa-stop' : 'fa-play'}"></i>
                        </button>
                        <button class="btn btn-sm btn-warning"
                                onclick="controlService('${service.name}', 'restart')" title="Restart Service">
                            <i class="fas fa-sync-alt"></i>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    `;
}

async function selectService(serviceName) {
    selectedService = serviceName;
    document.querySelectorAll('.service-card').forEach(card => {
        card.classList.remove('selected-service');
        if (card.dataset.serviceName === serviceName) {
            card.classList.add('selected-service');
        }
    });
    
    document.getElementById('journal-title').textContent = `Logs: ${serviceName}`;
    await updateJournal(serviceName);
}

async function updateJournal(serviceName) {
    try {
        document.getElementById('journal-container').innerHTML = `
            <div class="loading-spinner">
                <i class="fas fa-spinner"></i>
                <p>Loading logs...</p>
            </div>
        `;
        
        const response = await fetch(`/journal/${serviceName}`);
        const data = await response.json();
        const journalContainer = document.getElementById('journal-container');
        journalContainer.textContent = data.logs;
        journalContainer.scrollTop = journalContainer.scrollHeight;
    } catch (error) {
        console.error('Error fetching journal:', error);
        document.getElementById('journal-container').innerHTML = `
            <div class="text-danger">Error loading logs. Please try again.</div>
        `;
    }
}

let lastServicesData = [];

function updateServices(services) {
    isLoading = false;
    lastServicesData = services;
    
    const servicesSearchTerm = servicesSearchInput.value.toLowerCase();
    const filteredServices = services.filter(service => 
        service.name.toLowerCase().includes(servicesSearchTerm)
    );
    
    const favoritesSearchTerm = favoritesSearchInput.value.toLowerCase();
    const filteredFavorites = services.filter(service => 
        favorites.has(service.name) && 
        service.name.toLowerCase().includes(favoritesSearchTerm)
    );
    
    servicesContainer.innerHTML = filteredServices.length ? 
        filteredServices.map(service => createServiceCard(service, 'all')).join('') :
        '<div class="text-center text-muted">No services found</div>';

    document.getElementById('favorites-container').innerHTML = filteredFavorites.length ?
        filteredFavorites.map(service => createServiceCard(service, 'favorites')).join('') :
        '<div class="text-center text-muted">No favorite services found</div>';

    if (selectedService) {
        updateJournal(selectedService);
    }
}

function controlService(service, action) {
    socket.emit('service_action', {service, action});
}

socket.on('update_services', data => {
    updateServices(data.services);
});

servicesSearchInput.addEventListener('input', () => {
    if (!isLoading) updateServices(lastServicesData);
});

favoritesSearchInput.addEventListener('input', () => {
    if (!isLoading) updateServices(lastServicesData);
});

socket.on('connect', () => {
    showLoading('services-container');
    showLoading('favorites-container');
});

function showLoading(containerId) {
    document.getElementById(containerId).innerHTML = `
        <div class="loading-spinner">
            <i class="fas fa-spinner"></i>
            <p>Loading...</p>
        </div>
    `;
}