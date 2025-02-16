document.addEventListener('DOMContentLoaded', function() {
    const sideMenu = document.getElementById('sideMenu');
    const openMenuBtn = document.getElementById('openMenu');
    const closeMenuBtn = document.getElementById('closeMenu');

    openMenuBtn.addEventListener('click', () => {
        sideMenu.classList.add('active');
    });

    closeMenuBtn.addEventListener('click', () => {
        sideMenu.classList.remove('active');
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
        if (!sideMenu.contains(e.target) && !openMenuBtn.contains(e.target)) {
            sideMenu.classList.remove('active');
        }
    });
});
